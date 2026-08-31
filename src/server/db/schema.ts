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
//   stopped_free_expired free 到期未完成，下载已被阻断（受管；已有数据继续上传，不再有删除硬优先级）
//   deleted_by_cleanup   已被空间清理删除（终态）
//   removed_external     在 qBittorrent 中被外部删除（终态）
//   untracked            已脱管（移出受管分类，不被自动操作；移回受管分类自动重新纳管）
//
// 下载阻断与状态正交：downloadBlock.reasons 记录全部阻断原因（free_expired 等），
// mechanism 记录物理实现（file_prio = 文件全部置为不下载、仍上传；stopped = 整体停止，降级）。
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
    /** legacy 展示分数（旧 min-max 批内评分，仅对照/展示，不再是清理排序契约） */
    score: doublePrecision("score").notNull().default(0),
    /** upEma 是否已由有效采样区间初始化（false 时 upEma 值无意义，0 是有效速率） */
    emaInitialized: boolean("ema_initialized").notNull().default(false),
    /** 统一预测窗口内的预计上传字节；无可解释预测时为 null */
    expectedUploadBytes: doublePrecision("expected_upload_bytes"),
    /** rate_proxy / global_prior / fallback_heuristic */
    predictionKind: text("prediction_kind"),
    predictedAt: timestamp("predicted_at", { withTimezone: true }),
    /** 下载阻断：{ reasons: string[], mechanism: "file_prio" | "stopped" | null } */
    downloadBlock: jsonb("download_block")
      .$type<{ reasons: string[]; mechanism: "file_prio" | "stopped" | null }>(),
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
    /** 本次入场时记录的 free 截止时间，作为 free 周期标记；null = 不限时或未知（保守视为同周期） */
    freeEndTime: timestamp("free_end_time", { withTimezone: true }),
  },
  (t) => [uniqueIndex("seen_site_torrent_idx").on(t.siteId, t.siteTorrentId)],
);

// 清理计划快照（决策日志；计划是建议快照，不是继续删除的授权）
export const evictionPlans = pgTable(
  "eviction_plans",
  {
    id: serial("id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    volumeKey: text("volume_key").notNull(),
    triggerReason: text("trigger_reason").notNull().default("observed_below_threshold"),
    actualFreeBytes: bigint("actual_free_bytes", { mode: "number" }).notNull(),
    thresholdBytes: bigint("threshold_bytes", { mode: "number" }).notNull(),
    needBytes: bigint("need_bytes", { mode: "number" }).notNull(),
    status: text("status").notNull(),
    dryRun: boolean("dry_run").notNull().default(false),
    plan: jsonb("plan").notNull(),
  },
  (t) => [index("eviction_plans_created_idx").on(t.createdAt)],
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
