import { Hono } from "hono";
import { ZodError } from "zod";
import { desc, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { qbit, QbitClient } from "../qbit/client";
import { getSettings, saveSettings } from "../config";
import { MTeamAdapter } from "../pt/mteam";
import { getAdapters, resetAdapters } from "../pt/registry";
import type { PtCategory, SiteUserStats } from "../pt/types";
import { hasJob, jobStatuses, runJob } from "../jobs/scheduler";
import { getDiskGuardState } from "../jobs/diskGuard";
import { clearAllBlocks } from "../services/downloadControl";
import { logEvent } from "../services/events";
import { dayKey } from "../services/traffic";

export const api = new Hono();

api.onError((err, c) => {
  console.error("[api]", err);
  return c.json({ error: err.message }, 500);
});

api.get("/status", async (c) => {
  const s = getSettings();
  let freeSpace: number | null = null;
  let managedUsed: number | null = null;
  let qbitOk = false;
  let dlSpeed: number | null = null;
  let upSpeed: number | null = null;
  if (qbit.configured) {
    try {
      const obs = await qbit.diskObservation();
      freeSpace = obs.freeBytes;
      dlSpeed = obs.dlSpeed;
      upSpeed = obs.upSpeed;
      // 受管种子已占用的磁盘空间（已下载的选中字节数）
      const infos = await Promise.all(
        s.managedCategories.map((cat) => qbit.torrentsInfo({ category: cat })),
      );
      managedUsed = infos.flat().reduce((sum, t) => sum + Math.max(t.size - t.amount_left, 0), 0);
      qbitOk = true;
    } catch {
      qbitOk = false;
    }
  }
  return c.json({
    qbit: {
      configured: qbit.configured,
      connected: qbitOk,
      url: s.qbitUrl,
      // 全局实时速度（B/s），未连接或字段缺失时 null
      dlSpeedBytesPerSec: qbitOk ? dlSpeed : null,
      upSpeedBytesPerSec: qbitOk ? upSpeed : null,
    },
    mteam: { configured: Boolean(s.mtApiKey) },
    freeSpaceBytes: freeSpace,
    freeSpaceThresholdBytes: s.freeSpaceThresholdGB * 1024 ** 3,
    // pt-watcher 视角的可支配容量：剩余空间 + 受管种子已占用
    diskTotalBytes: freeSpace != null && managedUsed != null ? freeSpace + managedUsed : null,
    pressure: getDiskGuardState(),
    jobs: jobStatuses(),
  });
});

// 最近一次清理计划（真实/演练共用同一规划器；计划是建议快照，不是删除授权）
api.get("/plan", async (c) => {
  const rows = await db
    .select()
    .from(schema.evictionPlans)
    .orderBy(desc(schema.evictionPlans.createdAt))
    .limit(1);
  return c.json({ pressure: getDiskGuardState(), latest: rows[0] ?? null });
});

api.get("/torrents", async (c) => {
  const state = c.req.query("state");
  const rows = state
    ? await db.select().from(schema.torrents).where(eq(schema.torrents.state, state)).orderBy(desc(schema.torrents.addedAt))
    : await db.select().from(schema.torrents).orderBy(desc(schema.torrents.addedAt));
  return c.json(rows);
});

async function getTorrentRow(id: number) {
  const rows = await db.select().from(schema.torrents).where(eq(schema.torrents.id, id));
  return rows[0];
}

api.post("/torrents/:id/:action", async (c) => {
  const id = Number(c.req.param("id"));
  const action = c.req.param("action");
  const row = await getTorrentRow(id);
  if (!row) return c.json({ error: "not found" }, 404);

  switch (action) {
    case "stop":
      await qbit.stopTorrents([row.infoHash]);
      break;
    case "start":
      // 手动恢复：清除全部下载阻断并恢复（用户显式操作，接受可能的非 free 下载计费）
      await clearAllBlocks(row);
      if (row.state === "stopped_free_expired") {
        await db.update(schema.torrents).set({ state: "downloading" }).where(eq(schema.torrents.id, id));
      }
      break;
    case "delete":
      await qbit.deleteTorrents([row.infoHash], true);
      await db
        .update(schema.torrents)
        .set({ state: "deleted_by_cleanup", deletedAt: new Date() })
        .where(eq(schema.torrents.id, id));
      await logEvent("manual_delete", `手动删除: ${row.name}`, { torrentRef: row.infoHash });
      break;
    default:
      return c.json({ error: "unknown action" }, 400);
  }
  return c.json({ ok: true });
});

api.get("/stats/traffic", async (c) => {
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 30), 1), 365);
  const sinceDay = dayKey(new Date(Date.now() - (days - 1) * 86_400_000));
  const daily = await db
    .select()
    .from(schema.trafficDaily)
    .where(gte(schema.trafficDaily.day, sinceDay))
    .orderBy(schema.trafficDaily.day);
  const totals = (
    await db
      .select({
        uploadedBytes: sql<string>`coalesce(sum(${schema.trafficDaily.uploadedBytes}), 0)`,
        downloadedBytes: sql<string>`coalesce(sum(${schema.trafficDaily.downloadedBytes}), 0)`,
      })
      .from(schema.trafficDaily)
  )[0]!;
  return c.json({
    totals: {
      uploadedBytes: Number(totals.uploadedBytes),
      downloadedBytes: Number(totals.downloadedBytes),
    },
    daily: daily.map((d) => ({
      day: d.day,
      uploadedBytes: d.uploadedBytes,
      downloadedBytes: d.downloadedBytes,
    })),
  });
});

api.get("/stats/site", async (c) => {
  const out: SiteUserStats[] = [];
  for (const adapter of getAdapters()) {
    if (!adapter.getUserStats) continue;
    try {
      const s = await adapter.getUserStats();
      if (s) out.push(s);
    } catch (e) {
      console.error(`[api] getUserStats(${adapter.siteId}) failed:`, e);
    }
  }
  return c.json(out);
});

api.get("/events", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
  const offset = Number(c.req.query("offset") ?? 0);
  const rows = await db
    .select()
    .from(schema.events)
    .orderBy(desc(schema.events.ts))
    .limit(limit)
    .offset(offset);
  return c.json(rows);
});

api.get("/pt/categories", async (c) => {
  const all: PtCategory[] = [];
  for (const adapter of getAdapters()) {
    if (!adapter.listCategories) continue;
    try {
      all.push(...(await adapter.listCategories()));
    } catch (e) {
      console.error(`[api] listCategories(${adapter.siteId}) failed:`, e);
    }
  }
  return c.json(all);
});

api.get("/settings", (c) => c.json(getSettings()));

api.put("/settings", async (c) => {
  const body = await c.req.json();
  try {
    const saved = await saveSettings(body);
    resetAdapters();
    qbit.resetConnection();
    await logEvent("settings_updated", "配置已更新");
    return c.json(saved);
  } catch (e) {
    if (e instanceof ZodError) {
      const msg = e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return c.json({ error: msg }, 400);
    }
    return c.json({ error: String(e) }, 400);
  }
});

// 连接测试：用请求体里的表单当前值（可未保存），缺省回退到已保存配置
api.post("/test/mteam", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const s = getSettings();
  const apiKey = typeof body.mtApiKey === "string" ? body.mtApiKey : s.mtApiKey;
  const baseUrl =
    typeof body.mtBaseUrl === "string" && body.mtBaseUrl ? body.mtBaseUrl : s.mtBaseUrl;
  if (!apiKey) return c.json({ error: "请先填写 API Key" }, 400);
  try {
    const username = await new MTeamAdapter({ apiKey, baseUrl }).testConnection();
    return c.json({ ok: true, message: `连接成功，账号: ${username}` });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

api.post("/test/qbit", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const s = getSettings();
  const baseUrl = typeof body.qbitUrl === "string" && body.qbitUrl ? body.qbitUrl : s.qbitUrl;
  const apiKey = typeof body.qbitApiKey === "string" ? body.qbitApiKey : s.qbitApiKey;
  if (!baseUrl) return c.json({ error: "请先填写 WebUI 地址" }, 400);
  if (!apiKey) return c.json({ error: "请先填写 API Key" }, 400);
  try {
    const version = await new QbitClient({ baseUrl, apiKey }).appVersion();
    return c.json({ ok: true, message: `连接成功，qBittorrent ${version}` });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

api.post("/jobs/:name/run", async (c) => {
  const name = c.req.param("name");
  if (!hasJob(name)) return c.json({ error: "unknown job" }, 404);
  void runJob(name);
  return c.json({ ok: true, started: name });
});
