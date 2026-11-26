import { and, eq, gte } from "drizzle-orm";
import { db, schema } from "../db";
import { getSettings, saveSettings } from "../config";
import { getAdapters, resetAdapters } from "../pt/registry";
import { logEvent } from "./events";

const GB = 1024 ** 3;

interface WindowState {
  until: Date;
  /** 进入窗口时的站点累计下载量；null = 当时没拿到 */
  baselineDownloaded: number | null;
}

/** 每个站点当前已知的 VIP 窗口（进程内；重启后重新取基线） */
const windows = new Map<string, WindowState>();

/** 熔断判定：窗口内站点下载量比基线增长超过容差 */
export function downloadCounted(
  baseline: number | null,
  current: number | null | undefined,
  toleranceBytes: number,
): boolean {
  if (baseline === null || current === null || current === undefined) return false;
  return current - baseline > toleranceBytes;
}

/**
 * 窗口结束（到期 / 手动关闭 / 熔断）时，让 VIP 期加入、还在下载的种子立即接受 freeGuard 复核：
 * freeEndTime ≥ 原窗口截止的都可能只是借 VIP 窗口下载（真 free 的复核时会按站点 free 截止延期）。
 */
async function expireWindowTorrents(siteId: string, until: Date, now: Date): Promise<number> {
  const rows = await db
    .update(schema.torrents)
    .set({ freeEndTime: now })
    .where(
      and(
        eq(schema.torrents.siteId, siteId),
        eq(schema.torrents.state, "downloading"),
        gte(schema.torrents.freeEndTime, new Date(until.getTime() - 1000)),
      ),
    )
    .returning({ id: schema.torrents.id });
  return rows.length;
}

/**
 * VIP 窗口守卫（freeGuard 每轮先跑）：
 * - 进入窗口：记录基线下载量，记 vip_window_active
 * - 窗口内站点下载量增长超过容差：说明下载实际被计量，关闭 VIP 模式（vipMode=off）并停下非 free 下载
 * - 窗口结束：把借窗口下载的种子交给 freeGuard 立即复核
 */
export async function vipGuard(now = new Date()): Promise<void> {
  const s = getSettings();
  for (const adapter of getAdapters()) {
    if (!adapter.accountFreeUntil) continue;
    const until = await adapter.accountFreeUntil().catch(() => null);
    const prev = windows.get(adapter.siteId);

    if (!until) {
      if (prev) {
        windows.delete(adapter.siteId);
        const n = await expireWindowTorrents(adapter.siteId, prev.until, now);
        await logEvent("vip_window_ended", `VIP 期结束或已关闭，恢复只下 free；${n} 个下载中的种子交给 free 到期守卫复核`, {
          payload: { siteId: adapter.siteId, until: prev.until, rechecked: n },
        });
      }
      continue;
    }

    const stats = adapter.getUserStats ? await adapter.getUserStats().catch(() => null) : null;
    if (!prev || prev.until.getTime() !== until.getTime()) {
      windows.set(adapter.siteId, {
        until,
        baselineDownloaded: prev?.baselineDownloaded ?? stats?.downloadedBytes ?? null,
      });
      if (!prev) {
        await logEvent(
          "vip_window_active",
          `账号处于 VIP 期（下载不计量，至 ${until.toISOString()}），发现范围扩展到非 free 种子`,
          { payload: { siteId: adapter.siteId, until, mode: s.vipMode, baselineDownloaded: stats?.downloadedBytes ?? null } },
        );
      }
      continue;
    }

    if (downloadCounted(prev.baselineDownloaded, stats?.downloadedBytes, s.vipDownloadToleranceGB * GB)) {
      windows.delete(adapter.siteId);
      await saveSettings({ vipMode: "off" });
      resetAdapters();
      const n = await expireWindowTorrents(adapter.siteId, prev.until, now);
      const grew = ((stats!.downloadedBytes - prev.baselineDownloaded!) / GB).toFixed(1);
      await logEvent(
        "vip_suspended",
        `VIP 期内站点下载量增加了 ${grew}GB（容差 ${s.vipDownloadToleranceGB}GB），判定下载实际被计量：已关闭 VIP 模式，${n} 个下载中的种子交给 free 到期守卫复核`,
        {
          payload: {
            siteId: adapter.siteId,
            baselineDownloaded: prev.baselineDownloaded,
            currentDownloaded: stats!.downloadedBytes,
            rechecked: n,
          },
        },
      );
    }
  }
}
