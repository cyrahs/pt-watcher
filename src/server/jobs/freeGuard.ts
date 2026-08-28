import { and, eq, isNotNull, lt } from "drizzle-orm";
import { db, schema } from "../db";
import { qbit } from "../qbit/client";
import { getSettings } from "../config";
import { getAdapter } from "../pt/registry";
import { logEvent } from "../services/events";

/**
 * free 到期守卫：对 watcher 添加、仍在下载、free 有明确到期时间的种子，
 * 在到期前（提前量内）复核站点状态，free 未延期则停止下载，避免产生下载流量。
 */
export async function freeGuard(): Promise<void> {
  if (!qbit.configured) return;
  const s = getSettings();
  const deadline = new Date(Date.now() + s.freeStopLeadMinutes * 60 * 1000);

  const rows = await db
    .select()
    .from(schema.torrents)
    .where(
      and(
        eq(schema.torrents.state, "downloading"),
        eq(schema.torrents.addedByWatcher, true),
        isNotNull(schema.torrents.freeEndTime),
        lt(schema.torrents.freeEndTime, deadline),
      ),
    );

  for (const row of rows) {
    if (row.progress >= 1) continue; // reconcile 稍后会置 completed

    // 复核站点状态：free 可能被延长或转为不限时
    let extended = false;
    if (row.siteId && row.siteTorrentId) {
      const adapter = getAdapter(row.siteId);
      if (adapter) {
        try {
          const detail = await adapter.getDetail(row.siteTorrentId);
          if (detail) {
            if (detail.freeEndTime === null) {
              // 变为不限时 free
              await db
                .update(schema.torrents)
                .set({ freeEndTime: null })
                .where(eq(schema.torrents.id, row.id));
              await logEvent("free_extended", `free 转为不限时: ${row.name}`, {
                torrentRef: row.infoHash,
              });
              extended = true;
            } else if (detail.freeEndTime.getTime() > deadline.getTime()) {
              await db
                .update(schema.torrents)
                .set({ freeEndTime: detail.freeEndTime })
                .where(eq(schema.torrents.id, row.id));
              await logEvent(
                "free_extended",
                `free 延期至 ${detail.freeEndTime.toISOString()}: ${row.name}`,
                { torrentRef: row.infoHash },
              );
              extended = true;
            }
          }
          // detail 为 null（查询失败/种子消失）时保守停止：宁可少下不产生流量
        } catch {
          // 同上，保守停止
        }
      }
    }
    if (extended) continue;

    try {
      await qbit.stopTorrents([row.infoHash]);
    } catch (e) {
      await logEvent("free_guard_error", `停止失败: ${row.name}: ${String(e)}`, {
        torrentRef: row.infoHash,
      });
      continue;
    }
    await db
      .update(schema.torrents)
      .set({ state: "stopped_free_expired" })
      .where(eq(schema.torrents.id, row.id));
    await logEvent(
      "free_expired_stopped",
      `free 到期未完成，已停止下载: ${row.name} (进度 ${(row.progress * 100).toFixed(1)}%)`,
      { torrentRef: row.infoHash },
    );
  }
}
