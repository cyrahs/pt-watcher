import { inArray, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { buildInfo, getSettings } from "../config";
import { getAdapters } from "../pt/registry";
import type { SiteUserStats } from "../pt/types";
import { qbitOverview } from "../services/overview";
import {
  insertSystemSnapshot,
  insertTorrentSnapshots,
  latestSystemSnapshotAt,
  latestTorrentSnapshotAt,
  pruneSnapshots,
  snapshotDue,
  torrentSnapshotBatch,
} from "../services/snapshots";
import { getDiskGuardState } from "./diskGuard";
import { ACTIVE_STATES } from "./reconcile";

/** 检查间隔（秒）：只判定是否进入新的采样桶，实际落库频率由 snapshotIntervalSec 决定 */
export const SNAPSHOT_CHECK_INTERVAL_SEC = 60;

async function torrentCounts(): Promise<Record<string, number>> {
  const rows = await db
    .select({ state: schema.torrents.state, count: sql<number>`count(*)::int` })
    .from(schema.torrents)
    .groupBy(schema.torrents.state);
  return Object.fromEntries(rows.map((r) => [r.state, r.count]));
}

async function collectSiteStats(): Promise<SiteUserStats[]> {
  const out: SiteUserStats[] = [];
  for (const adapter of getAdapters()) {
    if (!adapter.getUserStats) continue;
    try {
      const stats = await adapter.getUserStats();
      if (stats) out.push(stats);
    } catch (e) {
      console.error(`[snapshot] getUserStats(${adapter.siteId}) failed:`, e);
    }
  }
  return out;
}

const round = (n: number | null) => (n === null ? null : Math.round(n));

/**
 * 定时快照（时间序列），每个 snapshotIntervalSec 桶各落一次：
 * - 种子快照：受管种子在 reconcile 最近一次采样时的计数与预测（见 torrentSnapshotBatch）
 * - 系统快照：剩余空间、速度、压力状态、各状态种子数、站点账号数据、部署版本
 */
export async function snapshotTick(): Promise<void> {
  const s = getSettings();
  const now = new Date();

  const rows = await db
    .select()
    .from(schema.torrents)
    .where(inArray(schema.torrents.state, [...ACTIVE_STATES]));
  const batch = torrentSnapshotBatch(rows, {
    now,
    lastTs: await latestTorrentSnapshotAt(),
    intervalSec: s.snapshotIntervalSec,
    // 容忍 reconcile 晚一轮（含调度 jitter）再判为过期
    maxAgeMs: (2 * s.reconcileIntervalSec + 60) * 1000,
    horizonSec: s.predictionHorizonSec,
  });
  if (batch.length > 0) await insertTorrentSnapshots(batch);

  if (!snapshotDue(await latestSystemSnapshotAt(), now, s.snapshotIntervalSec)) return;
  const [q, counts, siteStats] = await Promise.all([
    qbitOverview(s.managedCategories),
    torrentCounts(),
    collectSiteStats(),
  ]);
  const disk = getDiskGuardState();
  await insertSystemSnapshot({
    ts: now,
    gitSha: buildInfo.gitSha,
    qbitConnected: q.connected,
    freeBytes: round(q.freeBytes),
    managedUsedBytes: round(q.managedUsedBytes),
    dlSpeedBytesPerSec: q.dlSpeed,
    upSpeedBytesPerSec: q.upSpeed,
    pressureState: disk.state,
    pendingReleaseBytes: Math.round(disk.pendingReleaseBytes),
    torrentCounts: counts,
    siteStats,
  });
  await pruneSnapshots(now, s.snapshotRetentionDays);
}
