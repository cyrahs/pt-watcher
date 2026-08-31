import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db";
import { qbit } from "../qbit/client";
import { getSettings, type Settings } from "../config";
import { getAdapters } from "../pt/registry";
import type { FreeTorrent } from "../pt/types";
import { infoHashFromTorrent } from "../services/torrentFile";
import { logEvent } from "../services/events";
import { demandHeuristic } from "../services/value";
import { isNewFreeCycle } from "../services/freeCycle";
import { unblockDownload } from "../services/downloadControl";
import { ensureFreshObservation, isAdditionAllowed, getDiskGuardState } from "./diskGuard";
import { ACTIVE_STATES } from "./reconcile";

const GB = 1024 ** 3;

async function getSeen(siteId: string, torrentId: string) {
  const rows = await db
    .select()
    .from(schema.seenSiteTorrents)
    .where(
      and(
        eq(schema.seenSiteTorrents.siteId, siteId),
        eq(schema.seenSiteTorrents.siteTorrentId, torrentId),
      ),
    );
  return rows[0] ?? null;
}

/** 记录/更新本周期入场标记（freeEndTime 作为周期标识） */
async function markSeen(siteId: string, torrentId: string, freeEndTime: Date | null) {
  await db
    .insert(schema.seenSiteTorrents)
    .values({ siteId, siteTorrentId: torrentId, freeEndTime, seenAt: new Date() })
    .onConflictDoUpdate({
      target: [schema.seenSiteTorrents.siteId, schema.seenSiteTorrents.siteTorrentId],
      set: { freeEndTime, seenAt: new Date() },
    });
}

/**
 * seen 是否阻止本次入场：同一 free 周期内防抖；新周期且本地已无活跃记录则恢复资格。
 * （seen 不再是永久排除，交接文稿 §6.3）
 */
async function seenBlocks(t: FreeTorrent, now: number): Promise<boolean> {
  const rec = await getSeen(t.siteId, t.torrentId);
  if (!rec) return false;
  if (!isNewFreeCycle(rec.freeEndTime, t.freeEndTime, now)) return true;
  // 新周期：本地仍有非终态记录（活跃/已脱管）时不重加，由已有行走恢复路径
  const rows = await db
    .select({ id: schema.torrents.id })
    .from(schema.torrents)
    .where(
      and(
        eq(schema.torrents.siteId, t.siteId),
        eq(schema.torrents.siteTorrentId, t.torrentId),
        inArray(schema.torrents.state, [...ACTIVE_STATES, "untracked"]),
      ),
    );
  return rows.length > 0;
}

export function passesFilters(
  t: FreeTorrent,
  s: Pick<Settings, "onlyTimeLimitedFree" | "minFreeHours" | "minSizeGB" | "maxSizeGB">,
  now = Date.now(),
): { ok: boolean; reason?: string } {
  if (t.freeEndTime === null) {
    if (s.onlyTimeLimitedFree) return { ok: false, reason: "不限时 free（已配置只收限时）" };
  } else {
    const remainingHours = (t.freeEndTime.getTime() - now) / 3600000;
    if (remainingHours < s.minFreeHours) {
      return { ok: false, reason: `free 剩余 ${remainingHours.toFixed(1)}h < ${s.minFreeHours}h` };
    }
  }
  const sizeGB = t.sizeBytes / GB;
  if (s.minSizeGB > 0 && sizeGB < s.minSizeGB) return { ok: false, reason: `太小 ${sizeGB.toFixed(1)}GB` };
  if (s.maxSizeGB > 0 && sizeGB > s.maxSizeGB) return { ok: false, reason: `太大 ${sizeGB.toFixed(1)}GB` };
  return { ok: true };
}

/**
 * 入场排序（交接文稿 §10.1）：需求启发式为主（log1p(leechers/(seeders+1))，
 * 按 0.1 分桶保证可传递的确定性排序），同档内 free 截止时间升序作次级；
 * 不限时 free 不再被无条件排到最后（同档内排在有限期之后，但高需求档整体优先）。
 */
export function rankCandidates(list: FreeTorrent[]): FreeTorrent[] {
  const bucket = (t: FreeTorrent) => Math.round(demandHeuristic(t.leechers, t.seeders) * 10);
  return [...list].sort((a, b) => {
    const d = bucket(b) - bucket(a);
    if (d !== 0) return d;
    const at = a.freeEndTime?.getTime() ?? Infinity;
    const bt = b.freeEndTime?.getTime() ?? Infinity;
    if (at !== bt) return at - bt;
    return a.torrentId < b.torrentId ? -1 : a.torrentId > b.torrentId ? 1 : 0;
  });
}

/** 再次 free：恢复被 free 到期阻断的种子的下载（保留部分数据续下，§6.2） */
async function resumeReFreed(allFound: FreeTorrent[], now: number): Promise<void> {
  const s = getSettings();
  const blocked = await db
    .select()
    .from(schema.torrents)
    .where(eq(schema.torrents.state, "stopped_free_expired"));
  if (blocked.length === 0) return;

  const foundByKey = new Map(allFound.map((t) => [`${t.siteId}:${t.torrentId}`, t]));
  const leadMs = s.freeStopLeadMinutes * 60 * 1000;
  for (const row of blocked) {
    if (!row.siteId || !row.siteTorrentId) continue;
    const t = foundByKey.get(`${row.siteId}:${row.siteTorrentId}`);
    if (!t) continue;
    // 剩余授权太短（freeGuard 会立即再停）则不折腾
    if (t.freeEndTime !== null && t.freeEndTime.getTime() - now <= leadMs * 2) continue;
    try {
      await unblockDownload(row, "free_expired");
      await db
        .update(schema.torrents)
        .set({ state: "downloading", freeEndTime: t.freeEndTime })
        .where(eq(schema.torrents.id, row.id));
      await logEvent(
        "free_reentered",
        `再次进入 free，恢复下载（复用已有 ${(row.progress * 100).toFixed(1)}% 数据）: ${row.name}`,
        { torrentRef: row.infoHash },
      );
    } catch (e) {
      await logEvent("discover_error", `恢复下载失败: ${row.name}: ${String(e)}`, {
        torrentRef: row.infoHash,
      });
    }
  }
}

/**
 * 发现 free 种子并添加到 qBittorrent。
 * 不做空间预留、不按候选体积提前清理、不比较完整体积与空闲空间（交接文稿 §5.4）；
 * 磁盘压力/未知时整体暂缓新增下载增长（反压），实际空间变化由 diskGuard 高频监控处理。
 */
export async function discover(): Promise<void> {
  const s = getSettings();
  if (!s.discoverEnabled || !qbit.configured) return;
  const now = Date.now();

  // 磁盘门控：观测新鲜化后仅 HEALTHY 才允许新增下载增长
  await ensureFreshObservation();
  if (!isAdditionAllowed()) {
    const st = getDiskGuardState();
    await logEvent(
      "discover_deferred",
      `磁盘状态 ${st.state}（${st.freeBytes === null ? "空间未知" : `剩余 ${(st.freeBytes / GB).toFixed(1)}GB`}），本轮暂缓添加新种与恢复下载`,
    );
    return;
  }

  // 收集站点 free 列表
  const allFound: FreeTorrent[] = [];
  for (const adapter of getAdapters()) {
    try {
      allFound.push(...(await adapter.searchFree()));
    } catch (e) {
      await logEvent("discover_error", `[${adapter.siteId}] 搜索失败: ${String(e)}`);
    }
  }
  if (allFound.length === 0) return;

  // 已阻断种子再次 free → 恢复下载
  await resumeReFreed(allFound, now);

  // 过滤 + 周期防抖
  const candidates: FreeTorrent[] = [];
  for (const t of allFound) {
    if (!passesFilters(t, s, now).ok) continue;
    if (await seenBlocks(t, now)) continue;
    candidates.push(t);
  }
  if (candidates.length === 0) return;

  const batch = rankCandidates(candidates).slice(0, s.maxAddPerRun);

  for (const t of batch) {
    try {
      const adapter = getAdapters().find((a) => a.siteId === t.siteId)!;
      const file = await adapter.fetchTorrentFile(t.torrentId);
      const infoHash = await infoHashFromTorrent(file);

      // DB 已有记录（通常是 reconcile 收养的手动添加种子）：回填站点信息，
      // 让它获得 freeGuard 保护（freeGuard 按 site_id 是否存在判定）
      const existing = (
        await db.select().from(schema.torrents).where(eq(schema.torrents.infoHash, infoHash))
      )[0];
      if (existing) {
        if (!existing.siteId) {
          await db
            .update(schema.torrents)
            .set({ siteId: t.siteId, siteTorrentId: t.torrentId, freeEndTime: t.freeEndTime })
            .where(eq(schema.torrents.id, existing.id));
          await logEvent(
            "site_backfilled",
            `识别到手动添加的站点 free 种子，已补全信息并纳入 free 到期保护: ${existing.name}`,
            { torrentRef: infoHash, payload: { siteId: t.siteId, siteTorrentId: t.torrentId } },
          );
        }
        await markSeen(t.siteId, t.torrentId, t.freeEndTime);
        continue;
      }

      // qBittorrent 已有但 DB 没有（手动添加且 reconcile 尚未跑，或在非受管分类）
      const inQbit = (await qbit.torrentsInfo({ hashes: [infoHash] }))[0];
      if (inQbit) {
        if (new Set(s.managedCategories).has(inQbit.category)) {
          await db.insert(schema.torrents).values({
            infoHash,
            siteId: t.siteId,
            siteTorrentId: t.torrentId,
            name: inQbit.name,
            sizeBytes: inQbit.size,
            category: inQbit.category,
            state: inQbit.progress >= 1 ? "completed" : "downloading",
            addedByWatcher: false,
            freeEndTime: t.freeEndTime,
            progress: inQbit.progress,
            ratio: inQbit.ratio,
            // 收养前的流量不计入 pt-watcher 统计，计数器从当前值起算
            lastUploadedBytes: inQbit.uploaded,
            lastDownloadedBytes: inQbit.downloaded,
            seeders: t.seeders,
            leechers: t.leechers,
            addedAt: new Date(inQbit.added_on * 1000),
          });
          await logEvent(
            "adopted",
            `识别到手动添加的站点 free 种子，已收养并纳入 free 到期保护: ${inQbit.name}`,
            { torrentRef: infoHash, payload: { siteId: t.siteId, siteTorrentId: t.torrentId } },
          );
        } else {
          await logEvent(
            "discover_skipped",
            `种子已存在于 qBittorrent 非受管分类 [${inQbit.category}]，跳过: ${inQbit.name}`,
            { torrentRef: infoHash },
          );
        }
        await markSeen(t.siteId, t.torrentId, t.freeEndTime);
        continue;
      }

      await qbit.addTorrentFile(file, {
        filename: `${t.siteId}-${t.torrentId}.torrent`,
        category: s.incomingCategory,
        tags: s.watcherTag,
      });
      await db.insert(schema.torrents).values({
        infoHash,
        siteId: t.siteId,
        siteTorrentId: t.torrentId,
        name: t.name,
        sizeBytes: t.sizeBytes,
        category: s.incomingCategory,
        state: "downloading",
        addedByWatcher: true,
        freeEndTime: t.freeEndTime,
        seeders: t.seeders,
        leechers: t.leechers,
      });
      await markSeen(t.siteId, t.torrentId, t.freeEndTime);
      await logEvent(
        "added",
        `添加 free 种子: ${t.name} (${(t.sizeBytes / GB).toFixed(1)}GB, free 至 ${
          t.freeEndTime ? t.freeEndTime.toISOString() : "不限"
        })`,
        { torrentRef: infoHash, payload: { siteId: t.siteId, siteTorrentId: t.torrentId } },
      );
    } catch (e) {
      await logEvent("discover_error", `添加失败: ${t.name}: ${String(e)}`);
    }
  }
}
