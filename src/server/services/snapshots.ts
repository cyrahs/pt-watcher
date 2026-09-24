import { desc, lt } from "drizzle-orm";
import { db, schema } from "../db";

export type TorrentSnapshotRow = typeof schema.torrentSnapshots.$inferInsert;
export type SystemSnapshotRow = typeof schema.systemSnapshots.$inferInsert;
type TorrentRow = typeof schema.torrents.$inferSelect;

/**
 * 按墙钟对齐的间隔桶判定是否该落快照：上次快照所在桶之后的首个时刻落一次。
 * 对齐桶而不是"距上次满间隔"，避免任务调度的 jitter 让快照时刻逐次漂移。
 */
export function snapshotDue(last: Date | null, now: Date, intervalSec: number): boolean {
  if (!last) return true;
  const ms = intervalSec * 1000;
  return Math.floor(now.getTime() / ms) > Math.floor(last.getTime() / ms);
}

/**
 * 从 torrents 表（reconcile 最近一次采样落库的值）生成种子快照批次：
 * - ts 取采样时刻 statSampledAt 而不是落库时刻，与当时的预测值严格对应；
 * - 采样过期（reconcile 停摆/失败）的行不落，避免把停滞的计数当成"上传走平"；
 * - 按最新采样所在的桶判定是否到期，已记录过的采样（statSampledAt <= 上次快照）不重复记录。
 */
export function torrentSnapshotBatch(
  rows: TorrentRow[],
  opts: { now: Date; lastTs: Date | null; intervalSec: number; maxAgeMs: number; horizonSec: number },
): TorrentSnapshotRow[] {
  const fresh = rows.filter(
    (r): r is TorrentRow & { statSampledAt: Date } =>
      r.statSampledAt !== null &&
      opts.now.getTime() - r.statSampledAt.getTime() <= opts.maxAgeMs &&
      (opts.lastTs === null || r.statSampledAt.getTime() > opts.lastTs.getTime()),
  );
  if (fresh.length === 0) return [];
  const latest = new Date(Math.max(...fresh.map((r) => r.statSampledAt.getTime())));
  if (!snapshotDue(opts.lastTs, latest, opts.intervalSec)) return [];
  return fresh.map((r) => ({
    ts: r.statSampledAt,
    torrentId: r.id,
    state: r.state,
    sizeBytes: r.sizeBytes,
    progress: r.progress,
    totalUploadedBytes: r.totalUploadedBytes,
    totalDownloadedBytes: r.totalDownloadedBytes,
    upEma: r.emaInitialized ? r.upEma : null,
    seeders: r.seeders,
    leechers: r.leechers,
    ratio: r.ratio,
    expectedUploadBytes: r.expectedUploadBytes,
    predictionKind: r.predictionKind,
    predictionHorizonSec: opts.horizonSec,
  }));
}

export async function latestTorrentSnapshotAt(): Promise<Date | null> {
  const t = schema.torrentSnapshots;
  const rows = await db.select({ ts: t.ts }).from(t).orderBy(desc(t.ts)).limit(1);
  return rows[0]?.ts ?? null;
}

export async function latestSystemSnapshotAt(): Promise<Date | null> {
  const t = schema.systemSnapshots;
  const rows = await db.select({ ts: t.ts }).from(t).orderBy(desc(t.ts)).limit(1);
  return rows[0]?.ts ?? null;
}

// 单条 INSERT 的参数上限是 65535，按行分批
const INSERT_CHUNK = 1000;

export async function insertTorrentSnapshots(rows: TorrentSnapshotRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await db.insert(schema.torrentSnapshots).values(rows.slice(i, i + INSERT_CHUNK));
  }
}

export async function insertSystemSnapshot(row: SystemSnapshotRow): Promise<void> {
  await db.insert(schema.systemSnapshots).values(row);
}

/** 按保留天数清理过期快照（retentionDays=0 不清理） */
export async function pruneSnapshots(now: Date, retentionDays: number): Promise<void> {
  if (retentionDays <= 0) return;
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  await db.delete(schema.torrentSnapshots).where(lt(schema.torrentSnapshots.ts, cutoff));
  await db.delete(schema.systemSnapshots).where(lt(schema.systemSnapshots.ts, cutoff));
}
