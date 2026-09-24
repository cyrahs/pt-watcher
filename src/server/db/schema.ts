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

// 发现候选日志：站点 free 列表里每个种子每个 free 周期一行，同周期内再次看到只更新该行。
// 记录首次看到时的站点特征（入场时的 swarm）与最近一次决策，含被过滤、排名靠后、暂缓的候选，
// 用于分析过滤条件与排序是否错过了好种子。经 infoHash / 站点种子 id 与 torrents 关联。
// decision: added / existing / filtered / seen / ranked_out / deferred / error（见 services/discoverLog.ts）
export const discoverCandidates = pgTable(
  "discover_candidates",
  {
    id: serial("id").primaryKey(),
    siteId: text("site_id").notNull(),
    siteTorrentId: text("site_torrent_id").notNull(),
    name: text("name").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    siteCategory: text("site_category"),
    /** 最近一次看到的 free 截止（周期内延期会更新）；null = 不限时 */
    freeEndTime: timestamp("free_end_time", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    seenCount: integer("seen_count").notNull().default(1),
    /** 首次看到时的 swarm（入场特征） */
    seeders: integer("seeders").notNull(),
    leechers: integer("leechers").notNull(),
    snatched: integer("snatched").notNull(),
    /** 最近一次看到时的 swarm（未入场候选的需求走势可作反事实的粗略代理） */
    lastSeeders: integer("last_seeders").notNull(),
    lastLeechers: integer("last_leechers").notNull(),
    lastSnatched: integer("last_snatched").notNull(),
    decision: text("decision").notNull(),
    reason: text("reason"),
    /** 最近一次进入排序时的名次（1 起）；未进入排序为 null */
    rank: integer("rank"),
    /** 本周期内被添加的时刻 */
    addedAt: timestamp("added_at", { withTimezone: true }),
    infoHash: text("info_hash"),
  },
  (t) => [
    index("discover_candidates_site_idx").on(t.siteId, t.siteTorrentId),
    index("discover_candidates_last_seen_idx").on(t.lastSeenAt),
  ],
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

// 受管种子的定时快照（时间序列）：snapshot 任务按 snapshotIntervalSec 取 reconcile 最近一次采样落库（ts = 采样时刻）。
// 某时刻的 expectedUploadBytes 对比之后一个预测窗口内 totalUploadedBytes 的实际增量，即可事后评估预测；
// 种子被删除后不再有快照（结合 torrents.deleted_at 判断删失）
export const torrentSnapshots = pgTable(
  "torrent_snapshots",
  {
    id: serial("id").primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    torrentId: integer("torrent_id").notNull(),
    state: text("state").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    progress: doublePrecision("progress").notNull(),
    totalUploadedBytes: bigint("total_uploaded_bytes", { mode: "number" }).notNull(),
    totalDownloadedBytes: bigint("total_downloaded_bytes", { mode: "number" }).notNull(),
    /** 上传速率 EMA（B/s）；null = 尚未由有效采样区间初始化 */
    upEma: doublePrecision("up_ema"),
    seeders: integer("seeders").notNull(),
    leechers: integer("leechers").notNull(),
    ratio: doublePrecision("ratio").notNull(),
    expectedUploadBytes: doublePrecision("expected_upload_bytes"),
    predictionKind: text("prediction_kind"),
    /** 该预测对应的窗口（秒）；配置可能变更，按快照记录 */
    predictionHorizonSec: integer("prediction_horizon_sec"),
  },
  (t) => [
    index("torrent_snapshots_ts_idx").on(t.ts),
    index("torrent_snapshots_torrent_ts_idx").on(t.torrentId, t.ts),
  ],
);

// 系统级定时快照：与种子快照同一采样间隔。剩余空间、速度、压力状态与站点账号数据的历史，
// 用于调阈值、观察真实优化目标（站点上传/分享率/魔力值）的走势，gitSha 把数据对应到部署版本
export const systemSnapshots = pgTable(
  "system_snapshots",
  {
    id: serial("id").primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    gitSha: text("git_sha"),
    qbitConnected: boolean("qbit_connected").notNull(),
    freeBytes: bigint("free_bytes", { mode: "number" }),
    /** 受管种子已占用（已下载的选中字节） */
    managedUsedBytes: bigint("managed_used_bytes", { mode: "number" }),
    dlSpeedBytesPerSec: doublePrecision("dl_speed_bytes_per_sec"),
    upSpeedBytesPerSec: doublePrecision("up_speed_bytes_per_sec"),
    pressureState: text("pressure_state").notNull(),
    pendingReleaseBytes: bigint("pending_release_bytes", { mode: "number" }).notNull().default(0),
    /** 各状态种子数 { state: count } */
    torrentCounts: jsonb("torrent_counts").$type<Record<string, number>>().notNull(),
    /** 各站点账号数据（SiteUserStats[]），取不到的站点缺席 */
    siteStats: jsonb("site_stats").notNull(),
  },
  (t) => [index("system_snapshots_ts_idx").on(t.ts)],
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
