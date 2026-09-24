import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  sql,
  type AnyColumn,
} from "drizzle-orm";
import { db, schema } from "../db";
import { apiConventions, endpointDocs } from "./docs";
import {
  escapeLike,
  parseBool,
  parseEnum,
  parseIdList,
  parseLimit,
  parseList,
  parseOffset,
  parsePositiveInt,
  parseTime,
  parseTorrentRef,
} from "./query";
import { qbit, QbitClient } from "../qbit/client";
import { buildInfo, diffSettings, getSettings, saveSettings } from "../config";
import { qbitOverview } from "../services/overview";
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
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error("[api]", err);
  return c.json({ error: err.message }, 500);
});

const ORDERS = ["asc", "desc"] as const;
type Order = (typeof ORDERS)[number];

/** 按 id 游标翻页：cursor 为上一页最后一条的 id */
function afterCursor(col: AnyColumn, cursor: number | undefined, order: Order) {
  if (cursor == null) return undefined;
  return order === "asc" ? gt(col, cursor) : lt(col, cursor);
}

function byId(col: AnyColumn, order: Order) {
  return order === "asc" ? asc(col) : desc(col);
}

api.get("/", (c) =>
  c.json({
    name: "pt-watcher",
    conventions: apiConventions,
    endpoints: endpointDocs.map((d) => ({ ...d, path: `/api${d.path === "/" ? "" : d.path}` })),
  }),
);

api.get("/status", async (c) => {
  const s = getSettings();
  const q = await qbitOverview(s.managedCategories);
  return c.json({
    version: buildInfo,
    qbit: {
      configured: qbit.configured,
      connected: q.connected,
      url: s.qbitUrl,
      // 全局实时速度（B/s），未连接或字段缺失时 null
      dlSpeedBytesPerSec: q.dlSpeed,
      upSpeedBytesPerSec: q.upSpeed,
    },
    mteam: { configured: Boolean(s.mtApiKey) },
    freeSpaceBytes: q.freeBytes,
    freeSpaceThresholdBytes: s.freeSpaceThresholdGB * 1024 ** 3,
    managedUsedBytes: q.managedUsedBytes,
    // pt-watcher 视角的可支配容量：剩余空间 + 受管种子已占用
    diskTotalBytes:
      q.freeBytes != null && q.managedUsedBytes != null ? q.freeBytes + q.managedUsedBytes : null,
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

const TORRENT_SORT = {
  addedAt: schema.torrents.addedAt,
  id: schema.torrents.id,
  name: schema.torrents.name,
  sizeBytes: schema.torrents.sizeBytes,
  upEma: schema.torrents.upEma,
  expectedUploadBytes: schema.torrents.expectedUploadBytes,
  totalUploadedBytes: schema.torrents.totalUploadedBytes,
  ratio: schema.torrents.ratio,
  seeders: schema.torrents.seeders,
  leechers: schema.torrents.leechers,
  freeEndTime: schema.torrents.freeEndTime,
};
const TORRENT_SORT_KEYS = Object.keys(TORRENT_SORT) as (keyof typeof TORRENT_SORT)[];

api.get("/torrents", async (c) => {
  const t = schema.torrents;
  const states = parseList(c.req.query("state"));
  const q = c.req.query("q")?.trim();
  const col = TORRENT_SORT[parseEnum("sort", c.req.query("sort"), TORRENT_SORT_KEYS, "addedAt")];
  const order = parseEnum("order", c.req.query("order"), ORDERS, "desc");
  const limitRaw = c.req.query("limit");
  const offset = parseOffset(c.req.query("offset"));

  let query = db
    .select()
    .from(t)
    .where(
      and(
        states ? inArray(t.state, states) : undefined,
        q ? ilike(t.name, `%${escapeLike(q)}%`) : undefined,
      ),
    )
    .orderBy(
      order === "asc" ? sql`${col} asc nulls last` : sql`${col} desc nulls last`,
      byId(t.id, order),
    )
    .$dynamic();
  // 不带 limit 保持旧行为：返回全部
  if (limitRaw) query = query.limit(parseLimit(limitRaw, 0, 5000));
  if (offset) query = query.offset(offset);
  return c.json(await query);
});

api.get("/torrents/:ref", async (c) => {
  const ref = parseTorrentRef(c.req.param("ref"));
  const rows = await db
    .select()
    .from(schema.torrents)
    .where(
      "id" in ref ? eq(schema.torrents.id, ref.id) : eq(schema.torrents.infoHash, ref.infoHash),
    );
  const torrent = rows[0];
  if (!torrent) return c.json({ error: "not found" }, 404);
  const recentEvents = await db
    .select()
    .from(schema.events)
    .where(eq(schema.events.torrentRef, torrent.infoHash))
    .orderBy(desc(schema.events.id))
    .limit(50);
  return c.json({ torrent, recentEvents });
});

api.get("/snapshots/torrents", async (c) => {
  const s = schema.torrentSnapshots;
  const ids = parseIdList("torrentId", c.req.query("torrentId"));
  const since = parseTime(c.req.query("since"));
  const until = parseTime(c.req.query("until"));
  const cursor = parsePositiveInt("cursor", c.req.query("cursor"));
  const order = parseEnum("order", c.req.query("order"), ORDERS, "asc");
  const limit = parseLimit(c.req.query("limit"), 1000, 10000);
  const rows = await db
    .select()
    .from(s)
    .where(
      and(
        ids ? inArray(s.torrentId, ids) : undefined,
        since ? gte(s.ts, since) : undefined,
        until ? lt(s.ts, until) : undefined,
        afterCursor(s.id, cursor, order),
      ),
    )
    .orderBy(byId(s.id, order))
    .limit(limit);
  return c.json(rows);
});

api.get("/snapshots/system", async (c) => {
  const s = schema.systemSnapshots;
  const since = parseTime(c.req.query("since"));
  const until = parseTime(c.req.query("until"));
  const cursor = parsePositiveInt("cursor", c.req.query("cursor"));
  const order = parseEnum("order", c.req.query("order"), ORDERS, "asc");
  const limit = parseLimit(c.req.query("limit"), 1000, 10000);
  const rows = await db
    .select()
    .from(s)
    .where(
      and(
        since ? gte(s.ts, since) : undefined,
        until ? lt(s.ts, until) : undefined,
        afterCursor(s.id, cursor, order),
      ),
    )
    .orderBy(byId(s.id, order))
    .limit(limit);
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
  const e = schema.events;
  const types = parseList(c.req.query("type"));
  const torrentRef = c.req.query("torrentRef")?.trim().toLowerCase();
  const since = parseTime(c.req.query("since"));
  const until = parseTime(c.req.query("until"));
  const cursor = parsePositiveInt("cursor", c.req.query("cursor"));
  const order = parseEnum("order", c.req.query("order"), ORDERS, "desc");
  const limit = parseLimit(c.req.query("limit"), 100, 5000);
  const offset = parseOffset(c.req.query("offset"));
  const rows = await db
    .select()
    .from(e)
    .where(
      and(
        types ? inArray(e.type, types) : undefined,
        torrentRef ? eq(e.torrentRef, torrentRef) : undefined,
        since ? gte(e.ts, since) : undefined,
        until ? lt(e.ts, until) : undefined,
        afterCursor(e.id, cursor, order),
      ),
    )
    .orderBy(byId(e.id, order))
    .limit(limit)
    .offset(offset);
  return c.json(rows);
});

const BUCKETS = ["none", "hour", "day"] as const;
// 分桶按服务器时区对齐（与 traffic_daily 的日切一致，部署时由 TZ 环境变量决定）
const SERVER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

api.get("/events/stats", async (c) => {
  const e = schema.events;
  const now = new Date();
  const since = parseTime(c.req.query("since"), now) ?? new Date(now.getTime() - 86_400_000);
  const until = parseTime(c.req.query("until"), now) ?? now;
  const bucket = parseEnum("bucket", c.req.query("bucket"), BUCKETS, "none");
  const types = parseList(c.req.query("type"));
  const where = and(gte(e.ts, since), lt(e.ts, until), types ? inArray(e.type, types) : undefined);
  const count = sql<number>`count(*)::int`;

  const rows =
    bucket === "none"
      ? await db
          .select({ type: e.type, count })
          .from(e)
          .where(where)
          .groupBy(e.type)
          .orderBy(e.type)
      : await db
          .select({
            // bucket 已校验为枚举值，可安全内联；按序号分组避免参数化表达式在 GROUP BY 中不匹配
            bucket: sql`date_trunc(${sql.raw(`'${bucket}'`)}, ${e.ts}, ${SERVER_TZ})`.mapWith(e.ts),
            type: e.type,
            count,
          })
          .from(e)
          .where(where)
          .groupBy(sql`1`, sql`2`)
          .orderBy(sql`1`, sql`2`);
  return c.json({ since, until, bucket, timeZone: SERVER_TZ, rows });
});

api.get("/plans", async (c) => {
  const p = schema.evictionPlans;
  const statuses = parseList(c.req.query("status"));
  const dryRun = parseBool("dryRun", c.req.query("dryRun"));
  const since = parseTime(c.req.query("since"));
  const until = parseTime(c.req.query("until"));
  const cursor = parsePositiveInt("cursor", c.req.query("cursor"));
  const order = parseEnum("order", c.req.query("order"), ORDERS, "desc");
  const limit = parseLimit(c.req.query("limit"), 50, 1000);
  const rows = await db
    .select()
    .from(p)
    .where(
      and(
        statuses ? inArray(p.status, statuses) : undefined,
        dryRun != null ? eq(p.dryRun, dryRun) : undefined,
        since ? gte(p.createdAt, since) : undefined,
        until ? lt(p.createdAt, until) : undefined,
        afterCursor(p.id, cursor, order),
      ),
    )
    .orderBy(byId(p.id, order))
    .limit(limit);
  return c.json(rows);
});

api.get("/discover/candidates", async (c) => {
  const d = schema.discoverCandidates;
  const decisions = parseList(c.req.query("decision"));
  const siteId = c.req.query("siteId") || undefined;
  const added = parseBool("added", c.req.query("added"));
  const since = parseTime(c.req.query("since"));
  const until = parseTime(c.req.query("until"));
  const cursor = parsePositiveInt("cursor", c.req.query("cursor"));
  const order = parseEnum("order", c.req.query("order"), ORDERS, "desc");
  const limit = parseLimit(c.req.query("limit"), 500, 5000);
  const rows = await db
    .select()
    .from(d)
    .where(
      and(
        decisions ? inArray(d.decision, decisions) : undefined,
        siteId ? eq(d.siteId, siteId) : undefined,
        added === true ? isNotNull(d.addedAt) : added === false ? isNull(d.addedAt) : undefined,
        since ? gte(d.lastSeenAt, since) : undefined,
        until ? lt(d.lastSeenAt, until) : undefined,
        afterCursor(d.id, cursor, order),
      ),
    )
    .orderBy(byId(d.id, order))
    .limit(limit);
  return c.json(rows);
});

api.get("/plans/:id", async (c) => {
  const id = parsePositiveInt("id", c.req.param("id"))!;
  const rows = await db.select().from(schema.evictionPlans).where(eq(schema.evictionPlans.id, id));
  if (!rows[0]) return c.json({ error: "not found" }, 404);
  return c.json(rows[0]);
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
    const before = getSettings();
    const saved = await saveSettings(body);
    resetAdapters();
    qbit.resetConnection();
    const changes = diffSettings(before, saved);
    const keys = Object.keys(changes);
    await logEvent(
      "settings_updated",
      keys.length > 0 ? `配置已更新: ${keys.join(", ")}` : "配置已保存（无变更）",
      { payload: { changes } },
    );
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
