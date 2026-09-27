import { and, eq, isNotNull, lt } from "drizzle-orm";
import { db, schema } from "../db";
import { qbit } from "../qbit/client";
import { getSettings, type Settings } from "../config";
import { getAdapter } from "../pt/registry";
import { logEvent } from "../services/events";
import { blockDownload } from "../services/downloadControl";
import { reclaimableBytes } from "./diskGuard";

/**
 * 阻断原因：区分站点确认的到期与复核失败时的保守停止（后者可能是误停，需要单独统计）。
 * - expired：站点返回的 free 未延期（已到期或已取消）
 * - site_unavailable：站点复核拿不到结果（请求失败或种子已不存在）
 * - no_site_adapter：该站点未配置，无法复核
 */
type StopReason = "expired" | "site_unavailable" | "no_site_adapter";

const STOP_REASON_TEXT: Record<StopReason, string> = {
  expired: "free 到期未完成",
  site_unavailable: "free 即将到期且站点复核失败（保守停止）",
  no_site_adapter: "free 即将到期且站点未配置无法复核（保守停止）",
};

/**
 * free 到期守卫：对已知站点信息（watcher 添加，或 discover 识别的手动添加）、
 * 仍在下载、free 有明确到期时间的种子，在到期前（提前量内）复核站点状态，
 * free 未延期则阻断下载，避免产生站点计费下载量。
 *
 * 只阻断下载：已取得的部分数据继续上传（file_prio 机制，见 downloadControl）。
 * 到期不再意味着删除优先级——保留价值由统一的价值估计评价。
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
        // 有站点信息即受保护（含 discover 识别/回填的手动添加种子），
        // 而不是只看 added_by_watcher
        isNotNull(schema.torrents.siteId),
        isNotNull(schema.torrents.freeEndTime),
        lt(schema.torrents.freeEndTime, deadline),
      ),
    );

  for (const row of rows) {
    if (row.progress >= 1) continue; // reconcile 稍后会置 completed

    // 复核站点状态：free 可能被延长或转为不限时
    let extended = false;
    let stopReason: StopReason = "no_site_adapter";
    if (row.siteId && row.siteTorrentId) {
      const adapter = getAdapter(row.siteId);
      if (adapter) {
        stopReason = "site_unavailable";
        try {
          const detail = await adapter.getDetail(row.siteTorrentId);
          if (detail) {
            stopReason = "expired";
            if (detail.freeEndTime === null) {
              // 变为不限时 free
              await db
                .update(schema.torrents)
                .set({ freeEndTime: null })
                .where(eq(schema.torrents.id, row.id));
              await logEvent("free_extended", `free 转为不限时: ${row.name}`, {
                torrentRef: row.infoHash,
                payload: { previousFreeEndTime: row.freeEndTime, freeEndTime: null },
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
                {
                  torrentRef: row.infoHash,
                  payload: { previousFreeEndTime: row.freeEndTime, freeEndTime: detail.freeEndTime },
                },
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
      await blockDownload(row, "free_expired");
    } catch (e) {
      await logEvent("free_guard_error", `阻断下载失败: ${row.name}: ${String(e)}`, {
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
      `${STOP_REASON_TEXT[stopReason]}，已阻断下载（已有 ${(row.progress * 100).toFixed(1)}% 数据继续上传）: ${row.name}`,
      {
        torrentRef: row.infoHash,
        payload: {
          reason: stopReason,
          progress: row.progress,
          sizeBytes: row.sizeBytes,
          totalDownloadedBytes: row.totalDownloadedBytes,
          totalUploadedBytes: row.totalUploadedBytes,
          freeEndTime: row.freeEndTime,
        },
      },
    );
  }

  await purgeNoData(s, Date.now());
}

/**
 * 无数据僵尸判定：阻断时进度为 0 的种子没有任何可上传的数据，可释放字节为 0，
 * 清理规划按 zero_reclaim 永久排除，会一直留在 qBittorrent 里。
 * free 截止后超过 purgeHours 仍无数据即删除；purgeHours = 0 关闭。
 * 有数据（哪怕未完成）的阻断种子仍交给清理规划按价值处理。
 */
export function noDataPurgeDue(
  row: { state: string; sizeBytes: number; progress: number; freeEndTime: Date | null },
  now: number,
  purgeHours: number,
): boolean {
  if (purgeHours <= 0 || row.state !== "stopped_free_expired" || row.freeEndTime === null) return false;
  if (reclaimableBytes(row) > 0) return false;
  return now - row.freeEndTime.getTime() >= purgeHours * 3600 * 1000;
}

/** 删除 free 截止后长期无数据的阻断种子；删除后为终态，再次 free 由 discover 按新周期重新入场 */
async function purgeNoData(s: Settings, now: number): Promise<void> {
  if (s.freeExpiredNoDataPurgeHours <= 0) return;
  const rows = await db
    .select()
    .from(schema.torrents)
    .where(eq(schema.torrents.state, "stopped_free_expired"));
  for (const row of rows) {
    if (!noDataPurgeDue(row, now, s.freeExpiredNoDataPurgeHours)) continue;
    try {
      await qbit.deleteTorrents([row.infoHash], true);
    } catch (e) {
      await logEvent("free_guard_error", `删除无数据种子失败: ${row.name}: ${String(e)}`, {
        torrentRef: row.infoHash,
      });
      continue;
    }
    await db
      .update(schema.torrents)
      .set({ state: "deleted_by_cleanup", deletedAt: new Date(now) })
      .where(eq(schema.torrents.id, row.id));
    const hours = (now - row.freeEndTime!.getTime()) / 3600000;
    await logEvent(
      "free_expired_purged",
      `free 截止 ${hours.toFixed(0)} 小时后仍无任何数据，已删除（可释放为 0，清理规划不会选中）: ${row.name}`,
      {
        torrentRef: row.infoHash,
        payload: {
          sizeBytes: row.sizeBytes,
          freeEndTime: row.freeEndTime,
          hoursSinceFreeEnd: Math.round(hours),
          mechanism: (row.downloadBlock as { mechanism?: string } | null)?.mechanism ?? null,
        },
      },
    );
  }
}
