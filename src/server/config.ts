import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "./db";

// ---- 部署层配置: 只从环境变量读取（数据库连接与监听端口，UI 可达之前就需要）----

export const env = {
  databaseUrl: process.env.DATABASE_URL ?? "",
  port: Number(process.env.PORT ?? 3000),
};

/** 版本标记（镜像构建时由 CI 注入 GIT_SHA），用于把运行数据对应到具体部署 */
export const buildInfo = {
  gitSha: process.env.GIT_SHA || null,
  startedAt: new Date().toISOString(),
};

// ---- 行为配置: 存 settings 表，UI 可编辑，此处定义 schema 与默认值 ----
// 连接类字段的环境变量仅作为 settings 表中尚无该值时的默认种子

export const settingsSchema = z.object({
  // 站点与下载器连接
  mtApiKey: z.string().default(process.env.MT_API_KEY ?? ""),
  mtBaseUrl: z.string().default(process.env.MT_BASE_URL ?? "https://api.m-team.cc/api"),
  qbitUrl: z.string().default(process.env.QBIT_URL ?? ""),
  qbitApiKey: z.string().default(process.env.QBIT_API_KEY ?? ""),

  // 受管分类
  managedCategories: z.array(z.string()).default(["pt-watcher"]),
  incomingCategory: z.string().default("pt-watcher"),
  watcherTag: z.string().default("pt-watcher"),

  // discover 过滤
  discoverEnabled: z.boolean().default(true),
  /** 只搜索这些站点分类 id，空 = 不限分类 */
  searchCategories: z.array(z.string()).default([]),
  /** 只下载限时 free（排除长期/不限时 free，通常是巨型合集包） */
  onlyTimeLimitedFree: z.boolean().default(true),
  minFreeHours: z.number().positive().default(24),
  minSizeGB: z.number().nonnegative().default(0),
  maxSizeGB: z.number().nonnegative().default(200),
  maxAddPerRun: z.number().int().positive().default(10),
  searchModes: z.array(z.string()).default(["normal"]),

  // 空间（阈值触发、零预留：仅当实测剩余空间低于阈值时才允许清理）
  freeSpaceThresholdGB: z.number().positive().default(100),
  cleanEnabled: z.boolean().default(true),
  cleanDryRun: z.boolean().default(true),
  /**
   * 新种探索保护（有界：规划无可行方案时自动降级动用保护期候选并记录）。
   * 默认 24h：线上数据里上传强烈前置（0–48h 贡献 95%），且候选池里未保护候选始终充足，
   * 保护期从未成为约束（见 IMPLEMENTATION_NOTES §7）
   */
  newTorrentProtectHours: z.number().nonnegative().default(24),
  /** 空间观测最大有效年龄；过期观测不能授权删除 */
  diskObservationMaxAgeSec: z.number().positive().default(20),
  /**
   * 释放确认窗口：删除下发后多久之内不要求在实测里到账（释放先记账，缺口按有效剩余算）。
   * 到期仍未到账超过容差 → 异常态：停止删除并阻断新增，到账追上后自动解除。
   * qBittorrent 的空间数字约 30s 刷新一次，窗口取其 3 倍。
   */
  releaseConfirmWindowSec: z.number().positive().default(90),

  // freeGuard
  freeStopLeadMinutes: z.number().nonnegative().default(15),
  /**
   * 阻断后仍无任何数据的种子（可释放字节为 0，清理规划按 zero_reclaim 永久排除）在 free 截止后
   * 超过 N 小时自动删除；0 = 不删。删除后为终态，再次 free 时由 discover 按新周期正常重新入场。
   */
  freeExpiredNoDataPurgeHours: z.number().nonnegative().default(24),

  // 价值估计
  /** 统一预测窗口（秒），默认 24h；候选间必须一致 */
  predictionHorizonSec: z.number().positive().default(86400),
  /**
   * 上传速率 EMA 半衰期（秒）。默认 21600（6h）：清理只删 lossValue 最小的种子，
   * 几分钟的记忆会把"此刻闲置"当成"无价值"；线上对比里 6h 记忆把误删种子之后 24h 的实际上传减半
   * （见 IMPLEMENTATION_NOTES §7）。233s 是旧 alpha=0.3 @ 120s 间隔的迁移等价值。
   */
  uploadEmaHalfLifeSec: z.number().positive().default(21600),

  // 时间序列快照（供事后评估预测与趋势分析）
  /** 受管种子快照间隔（秒）：每个间隔桶内的首轮 reconcile 落一次快照 */
  snapshotIntervalSec: z.number().int().positive().default(3600),
  /** 快照保留天数，0 = 永久保留 */
  snapshotRetentionDays: z.number().nonnegative().default(90),

  // legacy 评分权重（旧 min-max 批内评分，仅用于对照方案与过渡展示，不再是清理排序契约）
  weightUpload: z.number().default(0.4),
  weightDemand: z.number().default(0.3),
  weightRatio: z.number().default(0.1),
  weightAge: z.number().default(0.1),
  weightQbitPopularity: z.number().default(0.1),
  ageHalfLifeDays: z.number().positive().default(14),

  // job 间隔（秒）
  discoverIntervalSec: z.number().int().positive().default(600),
  freeGuardIntervalSec: z.number().int().positive().default(60),
  /** @deprecated 旧 spaceClean 任务间隔，已由 diskCheckIntervalSec 取代；保留以兼容旧配置 JSON */
  spaceCleanIntervalSec: z.number().int().positive().default(300),
  reconcileIntervalSec: z.number().int().positive().default(120),
  /** 高频磁盘空间探测间隔（轻量，只读剩余空间） */
  diskCheckIntervalSec: z.number().int().positive().default(5),
});

export type Settings = z.infer<typeof settingsSchema>;

const SETTINGS_KEY = "app";

let cached: Settings | null = null;

export async function loadSettings(): Promise<Settings> {
  const rows = await db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, SETTINGS_KEY));
  const raw = rows[0]?.value ?? {};
  const parsed = settingsSchema.safeParse(raw);
  cached = parsed.success ? parsed.data : settingsSchema.parse({});
  return cached;
}

export function getSettings(): Settings {
  if (!cached) throw new Error("settings not loaded yet");
  return cached;
}

/** 含凭据的字段：变更记录只标记"已修改"，不记录值 */
const SECRET_KEYS: ReadonlySet<string> = new Set(["mtApiKey", "qbitApiKey"]);

export type SettingsDiff = Record<string, { from: unknown; to: unknown }>;

/** 两份配置的差异（供 settings_updated 事件记录，便于把行为变化归因到具体改动） */
export function diffSettings(before: Settings, after: Settings): SettingsDiff {
  const out: SettingsDiff = {};
  for (const key of Object.keys(after) as (keyof Settings)[]) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    out[key] = SECRET_KEYS.has(key)
      ? { from: "<redacted>", to: "<redacted>" }
      : { from: before[key], to: after[key] };
  }
  return out;
}

export async function saveSettings(patch: unknown): Promise<Settings> {
  const merged = settingsSchema.parse({ ...(cached ?? {}), ...(patch as object) });
  await db
    .insert(schema.settings)
    .values({ key: SETTINGS_KEY, value: merged, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: merged, updatedAt: new Date() },
    });
  cached = merged;
  return merged;
}
