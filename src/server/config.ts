import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "./db";

// ---- 部署层配置: 只从环境变量读取（数据库连接与监听端口，UI 可达之前就需要）----

export const env = {
  databaseUrl: process.env.DATABASE_URL ?? "",
  port: Number(process.env.PORT ?? 3000),
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
  /** 新种探索保护（有界：规划无可行方案时自动降级动用保护期候选并记录） */
  newTorrentProtectHours: z.number().nonnegative().default(6),
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

  // 价值估计
  /** 统一预测窗口（秒），默认 24h；候选间必须一致 */
  predictionHorizonSec: z.number().positive().default(86400),
  /** 上传速率 EMA 半衰期（秒）。默认 233s ≈ 旧 alpha=0.3 @ 120s 间隔的等价平滑强度 */
  uploadEmaHalfLifeSec: z.number().positive().default(233),

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
