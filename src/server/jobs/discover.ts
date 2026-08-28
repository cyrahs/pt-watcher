import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db";
import { qbit } from "../qbit/client";
import { getSettings } from "../config";
import { getAdapters } from "../pt/registry";
import type { FreeTorrent } from "../pt/types";
import { infoHashFromTorrent } from "../services/torrentFile";
import { logEvent } from "../services/events";
import { cleanSpace } from "./spaceClean";

const GB = 1024 ** 3;

async function isSeen(siteId: string, torrentId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.seenSiteTorrents.id })
    .from(schema.seenSiteTorrents)
    .where(
      and(
        eq(schema.seenSiteTorrents.siteId, siteId),
        eq(schema.seenSiteTorrents.siteTorrentId, torrentId),
      ),
    );
  return rows.length > 0;
}

async function markSeen(siteId: string, torrentId: string) {
  await db
    .insert(schema.seenSiteTorrents)
    .values({ siteId, siteTorrentId: torrentId })
    .onConflictDoNothing();
}

function passesFilters(t: FreeTorrent): { ok: boolean; reason?: string } {
  const s = getSettings();
  if (t.freeEndTime) {
    const remainingHours = (t.freeEndTime.getTime() - Date.now()) / 3600000;
    if (remainingHours < s.minFreeHours) {
      return { ok: false, reason: `free 剩余 ${remainingHours.toFixed(1)}h < ${s.minFreeHours}h` };
    }
  }
  const sizeGB = t.sizeBytes / GB;
  if (s.minSizeGB > 0 && sizeGB < s.minSizeGB) return { ok: false, reason: `太小 ${sizeGB.toFixed(1)}GB` };
  if (s.maxSizeGB > 0 && sizeGB > s.maxSizeGB) return { ok: false, reason: `太大 ${sizeGB.toFixed(1)}GB` };
  return { ok: true };
}

/** 发现 free 种子并添加到 qBittorrent */
export async function discover(): Promise<void> {
  const s = getSettings();
  if (!s.discoverEnabled || !qbit.configured) return;

  // 收集候选
  const candidates: FreeTorrent[] = [];
  for (const adapter of getAdapters()) {
    let found: FreeTorrent[];
    try {
      found = await adapter.searchFree();
    } catch (e) {
      await logEvent("discover_error", `[${adapter.siteId}] 搜索失败: ${String(e)}`);
      continue;
    }
    for (const t of found) {
      if (!passesFilters(t).ok) continue;
      if (await isSeen(t.siteId, t.torrentId)) continue;
      candidates.push(t);
    }
  }
  if (candidates.length === 0) return;

  // 大者优先能更充分利用 free，但也更容易占满；按剩余 free 时间升序（急的先下）
  candidates.sort((a, b) => {
    const at = a.freeEndTime?.getTime() ?? Infinity;
    const bt = b.freeEndTime?.getTime() ?? Infinity;
    return at - bt;
  });
  const batch = candidates.slice(0, s.maxAddPerRun);

  // 空间预检：现有未完成种子还要写入的量 + 本批大小
  const active = await db
    .select()
    .from(schema.torrents)
    .where(inArray(schema.torrents.state, ["downloading"]));
  const pendingBytes = active.reduce(
    (sum, r) => sum + Math.round(r.sizeBytes * (1 - r.progress)),
    0,
  );
  const batchBytes = batch.reduce((sum, t) => sum + t.sizeBytes, 0);
  const freeSpace = await qbit.freeSpaceOnDisk();
  const threshold = s.freeSpaceThresholdGB * GB;
  let budget = freeSpace - threshold - pendingBytes;

  if (budget < batchBytes) {
    await cleanSpace(batchBytes + pendingBytes);
    budget = (await qbit.freeSpaceOnDisk()) - threshold - pendingBytes;
  }

  for (const t of batch) {
    if (t.sizeBytes > budget) {
      await logEvent(
        "discover_skipped",
        `空间不足，跳过: ${t.name} (${(t.sizeBytes / GB).toFixed(1)}GB, 预算 ${(budget / GB).toFixed(1)}GB)`,
      );
      continue;
    }
    try {
      const adapter = getAdapters().find((a) => a.siteId === t.siteId)!;
      const file = await adapter.fetchTorrentFile(t.torrentId);
      const infoHash = await infoHashFromTorrent(file);

      const existing = await db
        .select({ id: schema.torrents.id })
        .from(schema.torrents)
        .where(eq(schema.torrents.infoHash, infoHash));
      if (existing.length > 0) {
        await markSeen(t.siteId, t.torrentId);
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
      await markSeen(t.siteId, t.torrentId);
      budget -= t.sizeBytes;
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
