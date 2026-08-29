import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../db";
import { qbit, type QbitTorrentInfo } from "../qbit/client";
import { getSettings } from "../config";
import { scoreBatch, updateEma, type ScoreInput } from "../services/popularity";
import { logEvent } from "../services/events";
import { addDailyTraffic, counterDelta } from "../services/traffic";

/** 仍受管、会被自动操作的状态 */
export const ACTIVE_STATES = ["downloading", "completed", "stopped_free_expired"] as const;

function stateFromQbit(q: QbitTorrentInfo, prevState?: string): string {
  if (prevState === "stopped_free_expired" && q.progress < 1) return "stopped_free_expired";
  return q.progress >= 1 ? "completed" : "downloading";
}

/**
 * 与 qBittorrent 对账（托管状态与分类强绑定）：
 * - 收养受管分类中未知的种子（added_by_watcher=false，参与清理不参与 freeGuard）
 * - 移出受管分类的置 untracked（脱管）
 * - 已脱管的种子移回受管分类则自动重新纳管
 * - qBit 中消失的置 removed_external
 * - 更新统计采样（上传速度 EMA、进度、swarm 数据）与流行度评分
 */
export async function reconcile(): Promise<void> {
  if (!qbit.configured) return;
  const s = getSettings();
  const managed = new Set(s.managedCategories);

  const all = await qbit.torrentsInfo();
  const byHash = new Map(all.map((t) => [t.hash.toLowerCase(), t]));

  const rows = await db
    .select()
    .from(schema.torrents)
    .where(inArray(schema.torrents.state, [...ACTIVE_STATES]));
  const knownHashes = new Set(rows.map((r) => r.infoHash));

  const now = new Date();
  let sumDeltaUp = 0;
  let sumDeltaDown = 0;

  // 第一遍：处理外部删除/脱管，收集受管种子的新采样值；评分是批内归一化，需集齐后统一计算
  const pending: ({
    row: (typeof rows)[number];
    q: QbitTorrentInfo;
    newState: string;
    deltaUp: number;
    deltaDown: number;
  } & ScoreInput)[] = [];

  for (const row of rows) {
    const q = byHash.get(row.infoHash);
    if (!q) {
      await db
        .update(schema.torrents)
        .set({ state: "removed_external", deletedAt: now })
        .where(eq(schema.torrents.id, row.id));
      await logEvent("removed_external", `种子已在 qBittorrent 中被外部删除: ${row.name}`, {
        torrentRef: row.infoHash,
      });
      continue;
    }
    if (!managed.has(q.category)) {
      await db
        .update(schema.torrents)
        .set({ state: "untracked", category: q.category, untrackedAt: now })
        .where(eq(schema.torrents.id, row.id));
      await logEvent("untracked", `种子移出受管分类，已脱管: ${row.name} → [${q.category}]`, {
        torrentRef: row.infoHash,
      });
      continue;
    }
    const newState = stateFromQbit(q, row.state);
    if (newState === "completed" && row.state === "downloading") {
      await logEvent("completed", `下载完成: ${row.name}`, { torrentRef: row.infoHash });
    }
    const deltaUp = counterDelta(q.uploaded, row.lastUploadedBytes);
    const deltaDown = counterDelta(q.downloaded, row.lastDownloadedBytes);
    sumDeltaUp += deltaUp;
    sumDeltaDown += deltaDown;
    pending.push({
      row,
      q,
      newState,
      deltaUp,
      deltaDown,
      upEma: updateEma(row.upEma, q.upspeed),
      seeders: q.num_complete,
      leechers: q.num_incomplete,
      ratio: q.ratio,
      ageDays: (now.getTime() - row.addedAt.getTime()) / 86400000,
      qbitPopularity: q.popularity ?? 0,
    });
  }

  // 第二遍：采样、状态与评分统一落库
  const scores = scoreBatch(pending, s);
  for (const p of pending) {
    const { row, q } = p;
    await db
      .update(schema.torrents)
      .set({
        state: p.newState,
        category: q.category,
        name: row.addedByWatcher ? row.name : q.name,
        sizeBytes: q.size,
        progress: q.progress,
        ratio: q.ratio,
        upEma: p.upEma,
        lastUploadedBytes: q.uploaded,
        lastDownloadedBytes: q.downloaded,
        totalUploadedBytes: row.totalUploadedBytes + p.deltaUp,
        totalDownloadedBytes: row.totalDownloadedBytes + p.deltaDown,
        seeders: p.seeders,
        leechers: p.leechers,
        qbitPopularity: p.qbitPopularity,
        score: scores.get(p) ?? row.score,
        statSampledAt: now,
      })
      .where(eq(schema.torrents.id, row.id));
  }

  await addDailyTraffic(sumDeltaUp, sumDeltaDown);

  // 已脱管的种子移回受管分类 → 自动重新纳管
  const untrackedRows = await db
    .select()
    .from(schema.torrents)
    .where(eq(schema.torrents.state, "untracked"));
  for (const row of untrackedRows) {
    const q = byHash.get(row.infoHash);
    if (!q || !managed.has(q.category)) continue;
    await db
      .update(schema.torrents)
      .set({
        state: stateFromQbit(q),
        category: q.category,
        untrackedAt: null,
        // 脱管期间的流量不计入统计，计数器从重新纳管时刻起算
        lastUploadedBytes: q.uploaded,
        lastDownloadedBytes: q.downloaded,
        statSampledAt: now,
      })
      .where(eq(schema.torrents.id, row.id));
    await logEvent("retracked", `种子移回受管分类，已重新纳管: ${row.name} [${q.category}]`, {
      torrentRef: row.infoHash,
    });
  }

  // 收养受管分类内的未知种子（跳过已有任何记录的 hash，避免重复收养终态记录）
  const allRows = await db
    .select({ infoHash: schema.torrents.infoHash })
    .from(schema.torrents);
  const anyKnown = new Set(allRows.map((r) => r.infoHash));

  for (const q of all) {
    const hash = q.hash.toLowerCase();
    if (!managed.has(q.category) || anyKnown.has(hash) || knownHashes.has(hash)) continue;
    await db.insert(schema.torrents).values({
      infoHash: hash,
      name: q.name,
      sizeBytes: q.size,
      category: q.category,
      state: stateFromQbit(q),
      addedByWatcher: false,
      progress: q.progress,
      ratio: q.ratio,
      upEma: q.upspeed,
      // 收养前的流量不计入 pt-watcher 统计，计数器从当前值起算
      lastUploadedBytes: q.uploaded,
      lastDownloadedBytes: q.downloaded,
      seeders: q.num_complete,
      leechers: q.num_incomplete,
      qbitPopularity: q.popularity ?? 0,
      addedAt: new Date(q.added_on * 1000),
      statSampledAt: now,
    });
    await logEvent("adopted", `收养受管分类内的外部种子: ${q.name} [${q.category}]`, {
      torrentRef: hash,
    });
  }
}
