import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../db";
import { qbit, type QbitTorrentInfo } from "../qbit/client";
import { getSettings } from "../config";
import { updateEma } from "../services/popularity";
import { logEvent } from "../services/events";

/** 仍受管、会被自动操作的状态 */
export const ACTIVE_STATES = ["downloading", "completed", "stopped_free_expired"] as const;

function stateFromQbit(q: QbitTorrentInfo, prevState?: string): string {
  if (prevState === "stopped_free_expired" && q.progress < 1) return "stopped_free_expired";
  return q.progress >= 1 ? "completed" : "downloading";
}

/**
 * 与 qBittorrent 对账：
 * - 收养受管分类中未知的种子（added_by_watcher=false，参与清理不参与 freeGuard）
 * - 移出受管分类的置 untracked（永久脱管）
 * - qBit 中消失的置 removed_external
 * - 更新统计采样（上传速度 EMA、进度、swarm 数据）
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
      await logEvent("untracked", `种子移出受管分类，已永久脱管: ${row.name} → [${q.category}]`, {
        torrentRef: row.infoHash,
      });
      continue;
    }
    // 采样与状态更新
    const newState = stateFromQbit(q, row.state);
    if (newState === "completed" && row.state === "downloading") {
      await logEvent("completed", `下载完成: ${row.name}`, { torrentRef: row.infoHash });
    }
    await db
      .update(schema.torrents)
      .set({
        state: newState,
        category: q.category,
        name: row.addedByWatcher ? row.name : q.name,
        sizeBytes: q.size,
        progress: q.progress,
        ratio: q.ratio,
        upEma: updateEma(row.upEma, q.upspeed),
        lastUploadedBytes: q.uploaded,
        seeders: q.num_complete,
        leechers: q.num_incomplete,
        qbitPopularity: q.popularity ?? 0,
        statSampledAt: now,
      })
      .where(eq(schema.torrents.id, row.id));
  }

  // 收养受管分类内的未知种子（跳过已有任何记录的 hash：untracked 的不重新纳管）
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
      lastUploadedBytes: q.uploaded,
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
