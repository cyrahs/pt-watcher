import {
  pgTable,
  serial,
  text,
  bigint,
  boolean,
  timestamp,
  doublePrecision,
  integer,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// 种子状态机:
//   downloading          下载中（受管）
//   completed            已完成/做种中（受管）
//   stopped_free_expired free 到期未完成，已被停止（受管，清理优先级最高）
//   deleted_by_cleanup   已被空间清理删除（终态）
//   removed_external     在 qBittorrent 中被外部删除（终态）
//   untracked            已脱管（移出受管分类，不被自动操作；移回受管分类自动重新纳管）
export const torrents = pgTable(
  "torrents",
  {
    id: serial("id").primaryKey(),
    infoHash: text("info_hash").notNull(),
    siteId: text("site_id"),
    siteTorrentId: text("site_torrent_id"),
    name: text("name").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    category: text("category").notNull().default(""),
    state: text("state").notNull().default("downloading"),
    addedByWatcher: boolean("added_by_watcher").notNull().default(false),
    freeEndTime: timestamp("free_end_time", { withTimezone: true }),
    // 采样/评分
    upEma: doublePrecision("up_ema").notNull().default(0),
    lastUploadedBytes: bigint("last_uploaded_bytes", { mode: "number" }).notNull().default(0),
    lastDownloadedBytes: bigint("last_downloaded_bytes", { mode: "number" }).notNull().default(0),
    // 受管期间累计流量（自流量统计功能上线/纳管起，按采样差值累加）
    totalUploadedBytes: bigint("total_uploaded_bytes", { mode: "number" }).notNull().default(0),
    totalDownloadedBytes: bigint("total_downloaded_bytes", { mode: "number" }).notNull().default(0),
    ratio: doublePrecision("ratio").notNull().default(0),
    progress: doublePrecision("progress").notNull().default(0),
    seeders: integer("seeders").notNull().default(0),
    leechers: integer("leechers").notNull().default(0),
    qbitPopularity: doublePrecision("qbit_popularity").notNull().default(0),
    score: doublePrecision("score").notNull().default(0),
    // 时间
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    statSampledAt: timestamp("stat_sampled_at", { withTimezone: true }),
    untrackedAt: timestamp("untracked_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("torrents_info_hash_idx").on(t.infoHash),
    index("torrents_state_idx").on(t.state),
  ],
);

export const seenSiteTorrents = pgTable(
  "seen_site_torrents",
  {
    id: serial("id").primaryKey(),
    siteId: text("site_id").notNull(),
    siteTorrentId: text("site_torrent_id").notNull(),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("seen_site_torrent_idx").on(t.siteId, t.siteTorrentId)],
);

export const events = pgTable(
  "events",
  {
    id: serial("id").primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    type: text("type").notNull(),
    torrentRef: text("torrent_ref"),
    message: text("message").notNull(),
    payload: jsonb("payload"),
  },
  (t) => [index("events_ts_idx").on(t.ts)],
);

// 受管种子每日流量聚合（day 为服务器本地日期 YYYY-MM-DD，部署时用 TZ 环境变量控制日切）
export const trafficDaily = pgTable("traffic_daily", {
  day: text("day").primaryKey(),
  uploadedBytes: bigint("uploaded_bytes", { mode: "number" }).notNull().default(0),
  downloadedBytes: bigint("downloaded_bytes", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
