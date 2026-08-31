import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../db";
import { qbit } from "../qbit/client";
import { getSettings } from "../config";
import { scoreBatch } from "../services/popularity";
import { estimateRetention, type ValueInput } from "../services/value";
import { logEvent } from "../services/events";
import { planEviction, type EvictionCandidate, type EvictionPlan } from "./evictionPlanner";
import { ACTIVE_STATES } from "./reconcile";

const GB = 1024 ** 3;
/** qBittorrent 只报告默认保存路径所在卷；多卷部署是已知限制（见 IMPLEMENTATION_NOTES） */
const VOLUME_KEY = "qbit-default";

export type PressureState = "HEALTHY" | "PRESSURE" | "RECLAIMING" | "BLOCKED" | "UNKNOWN";

interface Episode {
  startedAt: number;
  startFreeBytes: number;
  deletes: number;
  lastDeleteAt: number | null;
  freeAtLastDelete: number | null;
  noProgressCount: number;
  /** 事件去重：同一压力事件内相同内容的计划/提示只记录一次 */
  lastPlanSignature: string | null;
  /** dry-run 下的重规划节流（避免每 tick 全量评分写库） */
  lastPlanAt: number | null;
  loggedDisabled: boolean;
}

interface GuardState {
  state: PressureState;
  freeBytes: number | null;
  observedAt: number | null;
  blockedReason: string | null;
  episode: Episode | null;
}

const guard: GuardState = {
  state: "UNKNOWN",
  freeBytes: null,
  observedAt: null,
  blockedReason: null,
  episode: null,
};

export function getDiskGuardState(): {
  state: PressureState;
  volumeKey: string;
  freeBytes: number | null;
  observedAt: string | null;
  blockedReason: string | null;
  episodeDeletes: number;
} {
  return {
    state: guard.state,
    volumeKey: VOLUME_KEY,
    freeBytes: guard.freeBytes,
    observedAt: guard.observedAt ? new Date(guard.observedAt).toISOString() : null,
    blockedReason: guard.blockedReason,
    episodeDeletes: guard.episode?.deletes ?? 0,
  };
}

/** 新增下载写入（discover 加种/恢复下载）是否允许：仅 HEALTHY */
export function isAdditionAllowed(): boolean {
  return guard.state === "HEALTHY";
}

/** 观测实际剩余空间；失败/缺失 → null（未知 ≠ 0） */
async function observe(): Promise<number | null> {
  try {
    return await qbit.freeSpaceOnDisk();
  } catch {
    return null;
  }
}

function isFresh(now: number): boolean {
  const s = getSettings();
  return guard.observedAt !== null && now - guard.observedAt <= s.diskObservationMaxAgeSec * 1000;
}

/**
 * 供 discover 等调用方在决策前确保观测新鲜（§5.4：允许唤醒一次探测，
 * 但只更新观测与健康/压力状态，不在这里触发清理）。
 */
export async function ensureFreshObservation(): Promise<void> {
  const now = Date.now();
  if (isFresh(now)) return;
  const free = await observe();
  guard.freeBytes = free;
  guard.observedAt = free === null ? null : now;
  if (free === null) {
    guard.state = "UNKNOWN";
  } else if (guard.state === "UNKNOWN" || guard.state === "HEALTHY" || guard.state === "PRESSURE") {
    const threshold = getSettings().freeSpaceThresholdGB * GB;
    guard.state = free >= threshold ? "HEALTHY" : "PRESSURE";
  }
  // BLOCKED / RECLAIMING 状态由 tick 管理，这里不覆盖
}

type TorrentRow = typeof schema.torrents.$inferSelect;

/** 磁盘上实际占用的估计（未完成按进度折算；低置信度，见交接文稿 §9.3） */
function reclaimableBytes(row: TorrentRow): number {
  return Math.round(row.sizeBytes * (row.state === "completed" ? 1 : row.progress));
}

/** 构建候选快照 + 价值估计，并把预测持久化（UI 展示用） */
async function buildCandidates(
  now: number,
): Promise<{ candidates: EvictionCandidate[]; valueUnit: "bytes" | "heuristic" }> {
  const s = getSettings();
  const managed = new Set(s.managedCategories);
  const rows = await db
    .select()
    .from(schema.torrents)
    .where(inArray(schema.torrents.state, [...ACTIVE_STATES]));
  const eligible = rows.filter((r) => managed.has(r.category));

  const valueInputs: ValueInput[] = eligible.map((r) => ({
    id: r.id,
    emaRate: r.emaInitialized ? r.upEma : null,
    seeders: r.seeders,
    leechers: r.leechers,
    state: r.state,
  }));
  const { unit, byId } = estimateRetention(valueInputs, s.predictionHorizonSec);

  // legacy 评分（对照方案 + 过渡展示）
  const scores = scoreBatch(
    eligible.map((r) => ({
      row: r,
      upEma: r.upEma,
      seeders: r.seeders,
      leechers: r.leechers,
      ratio: r.ratio,
      ageDays: (now - r.addedAt.getTime()) / 86400000,
      qbitPopularity: r.qbitPopularity,
    })),
    s,
  );
  const legacyById = new Map<number, number>();
  for (const [item, score] of scores) legacyById.set(item.row.id, score);

  const predictedAt = new Date(now);
  await Promise.all(
    eligible.map((r) => {
      const v = byId.get(r.id)!;
      return db
        .update(schema.torrents)
        .set({
          score: legacyById.get(r.id) ?? 0,
          expectedUploadBytes: v.expectedUploadBytes,
          predictionKind: v.predictionKind,
          predictedAt,
        })
        .where(eq(schema.torrents.id, r.id));
    }),
  );

  const protectMs = s.newTorrentProtectHours * 3600 * 1000;
  const candidates: EvictionCandidate[] = eligible.map((r) => ({
    id: r.id,
    infoHash: r.infoHash,
    name: r.name,
    lossValue: byId.get(r.id)!.lossValue,
    reclaimableBytes: reclaimableBytes(r),
    protectedByAge: now - r.addedAt.getTime() <= protectMs,
    legacyScore: legacyById.get(r.id) ?? 0,
  }));
  return { candidates, valueUnit: unit };
}

function planSignature(plan: EvictionPlan, needBytes: number): string {
  const ids = plan.chosen.map((c) => c.id).join(",");
  // 缺口按 GB 取整参与签名，避免空间缓慢漂移导致每 tick 重复记录
  return `${plan.status}:${ids}:${Math.ceil(needBytes / GB)}`;
}

async function persistPlan(
  plan: EvictionPlan,
  freeBytes: number,
  thresholdBytes: number,
  dryRun: boolean,
): Promise<void> {
  await db.insert(schema.evictionPlans).values({
    volumeKey: VOLUME_KEY,
    triggerReason: "observed_below_threshold",
    actualFreeBytes: freeBytes,
    thresholdBytes,
    needBytes: plan.needBytes,
    status: plan.status,
    dryRun,
    plan: {
      valueUnit: plan.valueUnit,
      strategy: plan.strategy,
      chosen: plan.chosen.map((c) => ({
        id: c.id,
        name: c.name,
        lossValue: c.lossValue,
        reclaimableBytes: c.reclaimableBytes,
        evictionRank: c.evictionRank,
      })),
      expectedTotalLoss: plan.expectedTotalLoss,
      expectedTotalReclaim: plan.expectedTotalReclaim,
      expectedOvershoot: plan.expectedOvershoot,
      alternativesSummary: plan.alternativesSummary,
      usedProtected: plan.usedProtected,
      exclusions: plan.exclusions,
      reason: plan.reason ?? null,
    },
  });
}

function trip(reason: string): void {
  guard.state = "BLOCKED";
  guard.blockedReason = reason;
}

async function markRecovered(freeBytes: number): Promise<void> {
  if (guard.episode) {
    const freed = freeBytes - guard.episode.startFreeBytes;
    await logEvent(
      "space_recovered",
      `空间已恢复到阈值以上（剩余 ${(freeBytes / GB).toFixed(1)}GB，本次压力事件删除 ${
        guard.episode.deletes
      } 个种子，净变化 ${(freed / GB).toFixed(1)}GB），剩余清理计划作废`,
    );
  }
  guard.episode = null;
  guard.blockedReason = null;
  guard.state = "HEALTHY";
}

/**
 * 高频 tick：观测 → 状态机 → （压力下）规划并单步删除。
 * 不变量：实测 ≥ 阈值绝不删除；每次删除前用新鲜观测复核；恢复即停，剩余计划作废；
 * 删除成功 ≠ 空间已释放（下一 tick 按真实空间重算，不累加预计释放量）。
 */
export async function diskGuardTick(): Promise<void> {
  if (!qbit.configured) return;
  const s = getSettings();
  const threshold = s.freeSpaceThresholdGB * GB;
  const now = Date.now();

  const free = await observe();
  guard.freeBytes = free;
  guard.observedAt = free === null ? null : now;

  if (free === null) {
    if (guard.state !== "UNKNOWN") {
      await logEvent("disk_unknown", "磁盘空间观测失效（qBittorrent 不可达或字段缺失），暂停新增下载增长，不据此删除");
    }
    guard.state = "UNKNOWN";
    return;
  }

  if (free >= threshold) {
    if (guard.state !== "HEALTHY") await markRecovered(free);
    return;
  }

  // ---- 低于阈值：压力路径 ----
  const needBytes = threshold - free;
  if (!guard.episode) {
    guard.episode = {
      startedAt: now,
      startFreeBytes: free,
      deletes: 0,
      lastDeleteAt: null,
      freeAtLastDelete: null,
      noProgressCount: 0,
      lastPlanSignature: null,
      lastPlanAt: null,
      loggedDisabled: false,
    };
    await logEvent(
      "pressure_start",
      `磁盘空间低于阈值：剩余 ${(free / GB).toFixed(1)}GB < ${s.freeSpaceThresholdGB}GB，缺口 ${(needBytes / GB).toFixed(1)}GB`,
    );
  }
  const ep = guard.episode;

  if (guard.state === "BLOCKED") return; // 熔断跨 tick 保持，直到实测恢复到阈值以上

  if (!s.cleanEnabled) {
    guard.state = "PRESSURE";
    if (!ep.loggedDisabled) {
      ep.loggedDisabled = true;
      await logEvent("clean_disabled", "空间低于阈值但自动清理未启用；新增下载增长已暂停");
    }
    return;
  }

  // 等待上一次删除的释放被观测到（不在释放状态不明时继续累计删除）
  if (ep.lastDeleteAt !== null) {
    if (free > (ep.freeAtLastDelete ?? 0)) {
      ep.lastDeleteAt = null;
      ep.freeAtLastDelete = null;
      ep.noProgressCount = 0;
    } else if (now - ep.lastDeleteAt < s.deleteSettleTimeoutSec * 1000) {
      guard.state = "RECLAIMING";
      return;
    } else {
      ep.lastDeleteAt = null;
      ep.noProgressCount += 1;
      if (ep.noProgressCount >= 2) {
        trip("release_not_observed");
        await logEvent("clean_blocked", "连续删除后未观测到空间释放，已熔断（保持下载阻断，等待人工确认或空间恢复）");
        return;
      }
    }
  }

  if (ep.deletes >= s.maxDeletesPerEpisode) {
    trip("deletion_limit");
    await logEvent(
      "clean_blocked",
      `本次压力事件删除数已达上限 ${s.maxDeletesPerEpisode}，已熔断（不再追加删除，等待空间恢复或人工处理）`,
    );
    return;
  }

  guard.state = "PRESSURE";
  // dry-run 不删除，压力可能长期持续：重规划节流到每 60s，避免每 tick 全量评分写库
  if (s.cleanDryRun && ep.lastPlanAt !== null && now - ep.lastPlanAt < 60_000) return;
  ep.lastPlanAt = now;
  const { candidates, valueUnit } = await buildCandidates(now);
  const plan = planEviction(candidates, needBytes, valueUnit);
  const signature = planSignature(plan, needBytes);
  const isNewPlan = signature !== ep.lastPlanSignature;
  if (isNewPlan) {
    ep.lastPlanSignature = signature;
    await persistPlan(plan, free, threshold, s.cleanDryRun);
  }

  if (plan.status !== "feasible") {
    trip(plan.status);
    if (isNewPlan) {
      await logEvent(
        "clean_blocked",
        `无法生成可行清理计划（${plan.status}）：${plan.reason ?? ""}；保持下载阻断，不扩大删除范围`,
      );
    }
    return;
  }

  if (s.cleanDryRun) {
    // 演练：记录计划，不删除、不模拟释放、不解除压力
    if (isNewPlan) {
      const names = plan.chosen.map((c) => `${c.name}(${(c.reclaimableBytes / GB).toFixed(1)}GB)`).join("、");
      await logEvent(
        "clean_dry_run",
        `[dry-run] 低空间（缺口 ${(needBytes / GB).toFixed(1)}GB），计划删除 ${plan.chosen.length} 项（策略 ${plan.strategy}）: ${names}`,
        { payload: { strategy: plan.strategy, chosen: plan.chosen.map((c) => c.id) } },
      );
    }
    return;
  }

  // ---- 单步执行：每 tick 最多删一个，删除前用最新观测复核阈值 ----
  const target = plan.chosen[0]!;
  const fresh = await observe();
  guard.freeBytes = fresh;
  guard.observedAt = fresh === null ? null : Date.now();
  if (fresh === null) {
    guard.state = "UNKNOWN";
    return;
  }
  if (fresh >= threshold) {
    await markRecovered(fresh);
    return;
  }

  try {
    await qbit.deleteTorrents([target.infoHash], true);
  } catch (e) {
    await logEvent("clean_error", `删除失败: ${target.name}: ${String(e)}`, {
      torrentRef: target.infoHash,
    });
    return;
  }
  await db
    .update(schema.torrents)
    .set({ state: "deleted_by_cleanup", deletedAt: new Date() })
    .where(eq(schema.torrents.id, target.id));
  ep.deletes += 1;
  ep.lastDeleteAt = Date.now();
  ep.freeAtLastDelete = fresh;
  guard.state = "RECLAIMING";
  await logEvent(
    "cleaned",
    `空间清理删除: ${target.name}（预计释放 ${(target.reclaimableBytes / GB).toFixed(1)}GB，损失代理 ${target.lossValue.toFixed(3)}，策略 ${plan.strategy}）`,
    {
      torrentRef: target.infoHash,
      payload: { lossValue: target.lossValue, reclaimableBytes: target.reclaimableBytes },
    },
  );
}
