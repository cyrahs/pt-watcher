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
  qbitUser: z.string().default(process.env.QBIT_USER ?? ""),
  qbitPass: z.string().default(process.env.QBIT_PASS ?? ""),

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

  // 空间
  freeSpaceThresholdGB: z.number().positive().default(100),
  cleanEnabled: z.boolean().default(true),
  cleanDryRun: z.boolean().default(true),
  newTorrentProtectHours: z.number().nonnegative().default(6),

  // freeGuard
  freeStopLeadMinutes: z.number().nonnegative().default(15),

  // 评分权重
  weightUpload: z.number().default(0.4),
  weightDemand: z.number().default(0.3),
  weightRatio: z.number().default(0.1),
  weightAge: z.number().default(0.1),
  weightQbitPopularity: z.number().default(0.1),
  ageHalfLifeDays: z.number().positive().default(14),

  // job 间隔（秒）
  discoverIntervalSec: z.number().int().positive().default(600),
  freeGuardIntervalSec: z.number().int().positive().default(60),
  spaceCleanIntervalSec: z.number().int().positive().default(300),
  reconcileIntervalSec: z.number().int().positive().default(120),
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
