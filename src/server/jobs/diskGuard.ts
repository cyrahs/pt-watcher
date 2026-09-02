import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../db";
import { qbit } from "../qbit/client";
import { getSettings } from "../config";
import { scoreBatch } from "../services/popularity";
import { estimateRetention, type ValueInput } from "../services/value";
import { logEvent } from "../services/events";
import { planEviction, type EvictionCandidate, type EvictionPlan } from "./evictionPlanner";
import { ACTIVE_STATES } from "./reconcile";
import {
  additionAllowed,
  counterReset,
  rebaseAfterCounterReset,
  rebaseSettled,
  resolveObservedState,
  settleLedger,
  type DiskObservation,
  type LedgerSettlement,
  type PressureState,
  type ReleaseLedger,
} from "./diskGuardPolicy";

const GB = 1024 ** 3;
/** qBittorrent 只报告默认保存路径所在卷；多卷部署是已知限制（见 IMPLEMENTATION_NOTES） */
const VOLUME_KEY = "qbit-default";
/** qBittorrent 自身的剩余空间刷新周期：它的数字最多滞后这么久的写入 */
const QBIT_FREE_SPACE_REFRESH_MS = 30_000;
/** 规划不可行 / dry-run 下的重规划节流（避免每 tick 全量评分写库） */
const REPLAN_INTERVAL_MS = 60_000;

export type { PressureState } from "./diskGuardPolicy";

interface Episode {
  startedAt: number;
  startFreeBytes: number;
  deletes: number;
  /** 释放台账：已下发删除的记账与到账核对（见 diskGuardPolicy） */
  ledger: ReleaseLedger | null;
  /** 事件去重：同一压力事件内相同内容的计划/提示只记录一次 */
  lastPlanSignature: string | null;
  lastPlanAt: number | null;
  loggedDisabled: boolean;
}

interface GuardState {
  state: PressureState;
  freeBytes: number | null;
  observedAt: number | null;
  /** 实测 + 未到账释放 */
  effectiveFreeBytes: number | null;
  blockedReason: string | null;
  episode: Episode | null;
  settlement: LedgerSettlement | null;
  /** 最近的累计下载采样，用于估计 qBittorrent 空间数字尚未反映的写入量 */
  dlSamples: { at: number; downloadedBytes: number }[];
}

const guard: GuardState = {
  state: "UNKNOWN",
  freeBytes: null,
  observedAt: null,
  effectiveFreeBytes: null,
  blockedReason: null,
  episode: null,
  settlement: null,
  dlSamples: [],
};

export function getDiskGuardState(): {
  state: PressureState;
  volumeKey: string;
  freeBytes: number | null;
  observedAt: string | null;
  effectiveFreeBytes: number | null;
  /** 已下发删除、尚未在实测中体现的释放 */
  pendingReleaseBytes: number;
  blockedReason: string | null;
  episodeDeletes: number;
} {
  return {
    state: guard.state,
    volumeKey: VOLUME_KEY,
    freeBytes: guard.freeBytes,
    observedAt: guard.observedAt ? new Date(guard.observedAt).toISOString() : null,
    effectiveFreeBytes: guard.effectiveFreeBytes,
    pendingReleaseBytes: guard.settlement?.unreflectedBytes ?? 0,
    blockedReason: guard.blockedReason,
    episodeDeletes: guard.episode?.deletes ?? 0,
  };
}

/**
 * 新增下载写入（discover 加种/恢复下载）是否允许：HEALTHY 或 RECLAIMING。
 * RECLAIMING = 实测仍低于阈值但已下发删除的记账释放已覆盖缺口：删除在绝大多数情况下是即时的，
 * 只是 qBittorrent 的空间数字刷新滞后，因此先按"已释放"放行；到账核对由台账在确认窗口后完成
 * （扣除期间下载写入），真没释放会转入 BLOCKED 异常态再阻断（见 diskGuardPolicy.additionAllowed）。
 */
export function isAdditionAllowed(): boolean {
  return additionAllowed(guard.state);
}

/** 观测实际剩余空间与会话累计下载；失败/缺失 → null（未知 ≠ 0） */
async function observe(now: number): Promise<DiskObservation | null> {
  let raw: { freeBytes: number | null; downloadedBytes: number | null };
  try {
    raw = await qbit.diskObservation();
  } catch {
    raw = { freeBytes: null, downloadedBytes: null };
  }
  if (raw.freeBytes === null) {
    guard.freeBytes = null;
    guard.observedAt = null;
    return null;
  }
  const obs: DiskObservation = { at: now, freeBytes: raw.freeBytes, downloadedBytes: raw.downloadedBytes };
  guard.freeBytes = obs.freeBytes;
  guard.observedAt = now;
  if (obs.downloadedBytes !== null) {
    guard.dlSamples.push({ at: now, downloadedBytes: obs.downloadedBytes });
    guard.dlSamples = guard.dlSamples.filter((s) => now - s.at <= 2 * QBIT_FREE_SPACE_REFRESH_MS);
  }
  return obs;
}

/** 最近一个 qBittorrent 空间刷新周期内的下载写入量（它的空间数字可能还没反映这部分） */
function recentWriteBytes(obs: DiskObservation): number {
  if (obs.downloadedBytes === null) return 0;
  const cutoff = obs.at - QBIT_FREE_SPACE_REFRESH_MS;
  // 取不晚于 cutoff 的最新样本；没有则取最早样本（历史不足一个周期）
  const older = guard.dlSamples.filter((s) => s.at <= cutoff);
  const ref = older.length ? older[older.length - 1] : guard.dlSamples[0];
  if (!ref) return 0;
  return Math.max(0, obs.downloadedBytes - ref.downloadedBytes);
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
  const obs = await observe(now);
  // 熔断 / RECLAIMING 的推进与恢复清账由 tick 管理，这里只解析状态（熔断跨 UNKNOWN 保持）
  guard.state = resolveObservedState(
    guard.state,
    guard.blockedReason,
    obs?.freeBytes ?? null,
    getSettings().freeSpaceThresholdGB * GB,
  );
}

type TorrentRow = typeof schema.torrents.$inferSelect;

/** 磁盘上实际占用的估计（未完成按进度折算；低置信度，见交接文稿 §9.3） */
function reclaimableBytes(row: TorrentRow): number {
  return Math.round(row.sizeBytes * (row.state === "completed" ? 1 : row.progress));
}

/** 构建候选快照 + 价值估计（仅供规划；UI 展示的预测由 reconcile 每轮落库） */
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

/** 进入熔断；同一原因只记一次事件 */
async function block(reason: string, message: string, opts: { torrentRef?: string } = {}): Promise<void> {
  const changed = guard.blockedReason !== reason;
  guard.blockedReason = reason;
  guard.state = "BLOCKED";
  if (changed) await logEvent("clean_blocked", message, opts);
}

/** 解除熔断（异常自愈 / 规划重新可行） */
async function unblock(message: string): Promise<void> {
  if (guard.blockedReason === null) return;
  guard.blockedReason = null;
  await logEvent("clean_unblocked", message);
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
  guard.settlement = null;
  guard.blockedReason = null;
  guard.effectiveFreeBytes = freeBytes;
  guard.state = "HEALTHY";
}

/** 向 qBittorrent 核实台账里尚未确认消失的条目；查询失败返回 false（本 tick 不据此判异常） */
async function refreshPresence(ledger: ReleaseLedger): Promise<boolean> {
  const unconfirmed = ledger.entries.filter((e) => !e.gone);
  if (!unconfirmed.length) return true;
  let present: Set<string>;
  try {
    const rows = await qbit.torrentsInfo({ hashes: unconfirmed.map((e) => e.infoHash) });
    present = new Set(rows.map((r) => r.hash.toLowerCase()));
  } catch {
    return false;
  }
  for (const e of unconfirmed) if (!present.has(e.infoHash.toLowerCase())) e.gone = true;
  return true;
}

/**
 * 高频 tick：观测 → 台账核对 → 状态机 → （压力下）按有效缺口批量删除。
 * 不变量：实测 ≥ 阈值绝不删除；缺口 = 阈值 − (实测 + 未到账释放)，因此有效剩余 ≥ 实测，
 * 记账只会让删除更保守；新增下载门控同样看有效剩余（RECLAIMING 放行，见 isAdditionAllowed）；
 * 恢复即停，台账与剩余计划作废；
 * 熔断只在实测恢复到阈值以上、或异常自行消失（到账追上 / 种子消失 / 规划重新可行）时复位，
 * 观测失效（UNKNOWN）不解除熔断；删除的确认以 qBittorrent 不再持有该种子为准（见 diskGuardPolicy）。
 */
export async function diskGuardTick(): Promise<void> {
  if (!qbit.configured) return;
  const s = getSettings();
  const threshold = s.freeSpaceThresholdGB * GB;
  const now = Date.now();

  const obs = await observe(now);
  if (obs === null) {
    if (guard.state !== "UNKNOWN") {
      await logEvent("disk_unknown", "磁盘空间观测失效（qBittorrent 不可达或字段缺失），暂停新增下载增长，不据此删除");
    }
    guard.state = "UNKNOWN";
    return;
  }
  const free = obs.freeBytes;

  if (free >= threshold) {
    if (guard.state !== "HEALTHY" || guard.episode !== null || guard.blockedReason !== null) await markRecovered(free);
    guard.effectiveFreeBytes = free;
    return;
  }

  // ---- 低于阈值：压力路径 ----
  if (!guard.episode) {
    guard.episode = {
      startedAt: now,
      startFreeBytes: free,
      deletes: 0,
      ledger: null,
      lastPlanSignature: null,
      lastPlanAt: null,
      loggedDisabled: false,
    };
    await logEvent(
      "pressure_start",
      `磁盘空间低于阈值：剩余 ${(free / GB).toFixed(1)}GB < ${s.freeSpaceThresholdGB}GB，缺口 ${((threshold - free) / GB).toFixed(1)}GB`,
    );
  }
  const ep = guard.episode;

  if (!s.cleanEnabled) {
    guard.state = guard.blockedReason ? "BLOCKED" : "PRESSURE";
    guard.effectiveFreeBytes = free;
    if (!ep.loggedDisabled) {
      ep.loggedDisabled = true;
      await logEvent("clean_disabled", "空间低于阈值但自动清理未启用；新增下载增长已暂停");
    }
    return;
  }

  // ---- 台账核对：释放先记账，窗口到期后核对到账；异常态停止删除、阻断新增 ----
  let unreflected = 0;
  if (ep.ledger && counterReset(ep.ledger.base, obs)) ep.ledger = rebaseAfterCounterReset(ep.ledger, obs);
  if (ep.ledger && ep.ledger.entries.length > 0) {
    const presenceChecked = await refreshPresence(ep.ledger);
    const st = settleLedger(ep.ledger, obs, now, {
      windowMs: s.releaseConfirmWindowSec * 1000,
      recentWriteBytes: recentWriteBytes(obs),
      presenceChecked,
    });
    guard.settlement = st;
    if (st.anomaly === "delete_not_confirmed") {
      const stuck = ep.ledger.entries.filter((e) => !e.gone);
      guard.effectiveFreeBytes = free + st.unreflectedBytes;
      await block(
        st.anomaly,
        `删除下发 ${s.releaseConfirmWindowSec}s 后 qBittorrent 仍持有 ${stuck.length} 个种子（${stuck
          .slice(0, 3)
          .map((e) => e.name)
          .join("、")}${stuck.length > 3 ? "…" : ""}），删除未被确认；已停止继续删除并阻断新增下载，种子消失或空间恢复后自动解除`,
        { torrentRef: stuck[0]?.infoHash },
      );
      return;
    }
    if (st.anomaly === "release_not_observed") {
      guard.effectiveFreeBytes = free + st.unreflectedBytes;
      await block(
        st.anomaly,
        `已删除 ${(st.dueBytes / GB).toFixed(1)}GB 但 ${s.releaseConfirmWindowSec}s 内只观测到 ${(
          st.landedBytes / GB
        ).toFixed(1)}GB 释放（未到账 ${(st.dueUnconfirmedBytes / GB).toFixed(1)}GB > 容差 ${(
          st.toleranceBytes / GB
        ).toFixed(1)}GB）；已停止继续删除并阻断新增下载，到账追上或空间恢复后自动解除`,
      );
      return;
    }
    if (guard.blockedReason === "release_not_observed" || guard.blockedReason === "delete_not_confirmed") {
      await unblock(
        `释放到账已追上（累计到账 ${(st.landedBytes / GB).toFixed(1)}GB / 记账 ${(st.creditedBytes / GB).toFixed(1)}GB），解除熔断，恢复清理`,
      );
    }
    if (st.settled) {
      ep.ledger = rebaseSettled(obs);
      guard.settlement = null;
    } else {
      unreflected = st.unreflectedBytes;
    }
  } else {
    guard.settlement = null;
  }
  const effectiveFree = free + unreflected;
  guard.effectiveFreeBytes = effectiveFree;

  if (guard.blockedReason !== null) {
    // 规划不可行类熔断：候选会随保护期到期/下载完成而变化，按节流重试规划，可行即解除
    guard.state = "BLOCKED";
    if (ep.lastPlanAt !== null && now - ep.lastPlanAt < REPLAN_INTERVAL_MS) return;
  }

  const needBytes = threshold - effectiveFree;
  if (needBytes <= 0) {
    // 记账释放已覆盖缺口，等待到账；不追加删除
    guard.state = guard.blockedReason ? "BLOCKED" : "RECLAIMING";
    return;
  }

  // 规划/删除期间有 await，discover 可能并发读状态：在结果出来前保留上一 tick 的状态，
  // 避免"台账刚结清、马上就要补删"的瞬间被读成 PRESSURE 而白白暂缓一整轮 discover
  const pressureState: PressureState = guard.blockedReason === null ? "PRESSURE" : guard.state;
  // dry-run 不删除，压力可能长期持续：重规划节流，避免每 tick 全量评分写库
  if (s.cleanDryRun && ep.lastPlanAt !== null && now - ep.lastPlanAt < REPLAN_INTERVAL_MS) {
    guard.state = pressureState;
    return;
  }
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
    await block(
      plan.status,
      `无法生成可行清理计划（${plan.status}）：${plan.reason ?? ""}；保持下载阻断，不扩大删除范围，候选变化后自动重试`,
    );
    return;
  }
  if (guard.blockedReason !== null) {
    await unblock(`清理计划重新可行（${plan.strategy}），解除熔断，恢复清理`);
    guard.state = "PRESSURE";
  }

  if (s.cleanDryRun) {
    // 演练：记录计划，不删除、不记账、不解除压力
    guard.state = "PRESSURE";
    if (isNewPlan) {
      const names = plan.chosen.map((c) => `${c.name}(${(c.reclaimableBytes / GB).toFixed(1)}GB)`).join("、");
      await logEvent(
        "clean_dry_run",
        `[dry-run] 低空间（有效缺口 ${(needBytes / GB).toFixed(1)}GB），计划删除 ${plan.chosen.length} 项（策略 ${plan.strategy}）: ${names}`,
        { payload: { strategy: plan.strategy, chosen: plan.chosen.map((c) => c.id) } },
      );
    }
    return;
  }

  // ---- 批量执行：整份计划一次下发（本 tick 的实测已低于阈值，且记账只会让缺口更小）----
  const batch = plan.chosen;
  try {
    await qbit.deleteTorrents(
      batch.map((c) => c.infoHash),
      true,
    );
  } catch (e) {
    guard.state = "PRESSURE";
    await logEvent("clean_error", `删除失败（${batch.length} 项）: ${String(e)}`, {
      torrentRef: batch[0]?.infoHash,
    });
    return;
  }
  const deletedAt = Date.now();
  await db
    .update(schema.torrents)
    .set({ state: "deleted_by_cleanup", deletedAt: new Date(deletedAt) })
    .where(
      inArray(
        schema.torrents.id,
        batch.map((c) => c.id),
      ),
    );
  // 台账为空时起点取本 tick 观测（此前的释放都已到账并清账）
  if (!ep.ledger || ep.ledger.entries.length === 0) ep.ledger = { base: obs, entries: [] };
  for (const c of batch) {
    ep.ledger.entries.push({
      infoHash: c.infoHash,
      name: c.name,
      deletedAt,
      reclaimableBytes: c.reclaimableBytes,
      gone: false,
    });
  }
  ep.deletes += batch.length;
  guard.effectiveFreeBytes = free + unreflected + plan.expectedTotalReclaim;
  guard.state = "RECLAIMING";
  for (const c of batch) {
    await logEvent(
      "cleaned",
      `空间清理删除: ${c.name}（预计释放 ${(c.reclaimableBytes / GB).toFixed(1)}GB，损失代理 ${c.lossValue.toFixed(3)}，策略 ${plan.strategy}，本批 ${batch.length} 项覆盖有效缺口 ${(needBytes / GB).toFixed(1)}GB）`,
      {
        torrentRef: c.infoHash,
        payload: { lossValue: c.lossValue, reclaimableBytes: c.reclaimableBytes, batchSize: batch.length },
      },
    );
  }
}
