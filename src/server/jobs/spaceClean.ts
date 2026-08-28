import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../db";
import { qbit } from "../qbit/client";
import { getSettings } from "../config";
import { scoreBatch } from "../services/popularity";
import { logEvent } from "../services/events";
import { ACTIVE_STATES } from "./reconcile";

const GB = 1024 ** 3;

type TorrentRow = typeof schema.torrents.$inferSelect;

/** 磁盘上实际占用的字节（未完成的按进度折算） */
function onDiskBytes(row: TorrentRow): number {
  return Math.round(row.sizeBytes * (row.state === "completed" ? 1 : row.progress));
}

/**
 * 空间清理。reserveBytes 为额外需要预留的空间（discover 为 incoming 种子调用时传入）。
 * 返回本轮释放（或 dry-run 模拟释放）的字节数。
 */
export async function cleanSpace(reserveBytes = 0): Promise<number> {
  if (!qbit.configured) return 0;
  const s = getSettings();
  if (!s.cleanEnabled) return 0;

  const freeSpace = await qbit.freeSpaceOnDisk();
  const threshold = s.freeSpaceThresholdGB * GB;
  let needBytes = threshold + reserveBytes - freeSpace;
  if (needBytes <= 0) return 0;

  const managed = new Set(s.managedCategories);
  const rows = await db
    .select()
    .from(schema.torrents)
    .where(inArray(schema.torrents.state, [...ACTIVE_STATES]));

  const now = Date.now();
  const protectMs = s.newTorrentProtectHours * 3600 * 1000;
  const candidates = rows.filter(
    (r) => managed.has(r.category) && now - r.addedAt.getTime() > protectMs,
  );
  if (candidates.length === 0) {
    await logEvent("clean_skipped", `需要清理 ${(needBytes / GB).toFixed(1)}GB 但没有可清理的种子`);
    return 0;
  }

  // 评分并持久化（UI 展示用）
  const scores = scoreBatch(
    candidates.map((r) => ({
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
  const scored = [...scores.entries()].map(([item, score]) => ({ row: item.row, score }));
  for (const { row, score } of scored) {
    await db.update(schema.torrents).set({ score }).where(eq(schema.torrents.id, row.id));
  }

  // 排序：free 到期被停的未完成种子（死重）优先，其余按评分升序
  scored.sort((a, b) => {
    const aDead = a.row.state === "stopped_free_expired" ? 0 : 1;
    const bDead = b.row.state === "stopped_free_expired" ? 0 : 1;
    if (aDead !== bDead) return aDead - bDead;
    return a.score - b.score;
  });

  let freed = 0;
  const deleted: string[] = [];
  for (const { row, score } of scored) {
    if (needBytes <= 0) break;
    const bytes = onDiskBytes(row);
    if (s.cleanDryRun) {
      await logEvent(
        "clean_dry_run",
        `[dry-run] 将删除: ${row.name} (${(bytes / GB).toFixed(1)}GB, 评分 ${score.toFixed(3)})`,
        { torrentRef: row.infoHash, payload: { score, bytes } },
      );
    } else {
      try {
        await qbit.deleteTorrents([row.infoHash], true);
      } catch (e) {
        await logEvent("clean_error", `删除失败: ${row.name}: ${String(e)}`, {
          torrentRef: row.infoHash,
        });
        continue;
      }
      await db
        .update(schema.torrents)
        .set({ state: "deleted_by_cleanup", deletedAt: new Date(), score })
        .where(eq(schema.torrents.id, row.id));
      await logEvent(
        "cleaned",
        `空间清理删除: ${row.name} (${(bytes / GB).toFixed(1)}GB, 评分 ${score.toFixed(3)})`,
        { torrentRef: row.infoHash, payload: { score, bytes } },
      );
      deleted.push(row.name);
    }
    needBytes -= bytes;
    freed += bytes;
  }

  if (needBytes > 0) {
    await logEvent(
      "clean_insufficient",
      `清理后仍缺 ${(needBytes / GB).toFixed(1)}GB 空间（候选不足或均在保护期）`,
    );
  }
  return freed;
}
