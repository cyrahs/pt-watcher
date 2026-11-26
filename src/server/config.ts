import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "./db";

// ---- 部署层配置: 只从环境变量读取（数据库连接与监听端口，UI 可达之前就需要）----

export const env = {
  databaseUrl: process.env.DATABASE_URL ?? "",
  port: Number(process.env.PORT ?? 3000),
  /**
   * 凭据字段（mtApiKey / qbitApiKey）在 settings 表里的加密密钥（任意长度随机串，经 SHA-256 派生 AES-256 密钥）。
   * 未设置时凭据以明文存库（仅限本地开发），启动时会告警。
   */
  settingsSecretKey: process.env.SETTINGS_SECRET_KEY ?? "",
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
  // 只允许 M-Team 自己的域名：改成别的地址等于把 API key 发给那个地址
  mtBaseUrl: z
    .string()
    .default(process.env.MT_BASE_URL ?? "https://api.m-team.cc/api")
    .refine(isAllowedMteamBaseUrl, { message: "API 地址只能是 https://*.m-team.cc 或 https://*.m-team.io" }),
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

/** 含凭据的字段：API 只返回占位符，变更记录只标记"已修改"，库里加密存储 */
export const SECRET_KEYS: ReadonlySet<string> = new Set(["mtApiKey", "qbitApiKey"]);

/** API 返回凭据字段时的占位符；PUT 时原样传回（或传空串）表示保持不变 */
export const REDACTED = "<redacted>";

const ALLOWED_MTEAM_HOSTS = ["m-team.cc", "m-team.io"];

export function isAllowedMteamBaseUrl(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return ALLOWED_MTEAM_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

// ---- 凭据加密（AES-256-GCM，格式 enc:v1:<iv>:<tag>:<ciphertext>，均为 base64url）----

const ENC_PREFIX = "enc:v1:";

function cipherKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

export function encryptSecret(plain: string, secret: string): string {
  if (!plain || !secret) return plain;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", cipherKey(secret), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ENC_PREFIX + [iv, c.getAuthTag(), ct].map((b) => b.toString("base64url")).join(":");
}

export function isEncrypted(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(ENC_PREFIX);
}

/** 解密失败（密钥不对 / 数据损坏）抛错 */
export function decryptSecret(value: string, secret: string): string {
  if (!isEncrypted(value)) return value;
  if (!secret) throw new Error("settings 里的凭据已加密，但没有设置 SETTINGS_SECRET_KEY");
  const [iv, tag, ct] = value.slice(ENC_PREFIX.length).split(":").map((p) => Buffer.from(p, "base64url"));
  if (!iv || !tag || !ct) throw new Error("凭据密文格式错误");
  const d = createDecipheriv("aes-256-gcm", cipherKey(secret), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

/** 库里的原始 JSON → 明文凭据（只在进程内存里） */
export function decodeStoredSecrets(raw: Record<string, unknown>, secret: string): Record<string, unknown> {
  const out = { ...raw };
  for (const key of SECRET_KEYS) {
    const v = out[key];
    if (typeof v !== "string" || !isEncrypted(v)) continue;
    try {
      out[key] = decryptSecret(v, secret);
    } catch (e) {
      console.error(`[config] ${key} 解密失败，视为未配置:`, e instanceof Error ? e.message : e);
      out[key] = "";
    }
  }
  return out;
}

/** 明文配置 → 落库的 JSON（凭据加密） */
export function encodeSecretsForStorage(s: Settings, secret: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...s };
  for (const key of SECRET_KEYS) {
    const v = out[key];
    if (typeof v === "string" && v) out[key] = encryptSecret(v, secret);
  }
  return out;
}

/** 对外（REST / MCP / UI）返回的配置：凭据字段只给占位符，空值保持空串以便 UI 判断"未配置" */
export function publicSettings(s: Settings): Record<string, unknown> {
  const out: Record<string, unknown> = { ...s };
  for (const key of SECRET_KEYS) {
    if (typeof out[key] === "string" && out[key]) out[key] = REDACTED;
  }
  return out;
}

/**
 * PUT 补丁 → 新配置。凭据字段传占位符或空串 = 保持原值。
 * 改 qBittorrent 地址必须同时填写 API key，避免把已保存的 key 发给新地址（M-Team 地址由白名单约束）。
 */
export function mergeSettingsPatch(current: Settings, patch: Record<string, unknown>): Settings {
  const p: Record<string, unknown> = { ...patch };
  for (const key of SECRET_KEYS) {
    if (p[key] === REDACTED || p[key] === "" || p[key] === undefined) delete p[key];
  }
  if (typeof p.qbitUrl === "string" && p.qbitUrl !== current.qbitUrl && !("qbitApiKey" in p) && current.qbitApiKey) {
    throw new SettingsError("修改 qBittorrent 地址时需要同时重新填写 API Key");
  }
  const parsed = settingsSchema.safeParse({ ...current, ...p });
  if (!parsed.success) {
    throw new SettingsError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return parsed.data;
}

export class SettingsError extends Error {}

let cached: Settings | null = null;

export async function loadSettings(): Promise<Settings> {
  const rows = await db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, SETTINGS_KEY));
  let raw: unknown = rows[0]?.value ?? {};
  // 早期版本把整个 JSON 当成字符串存进了 jsonb
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = {};
    }
  }
  const stored = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const parsed = settingsSchema.safeParse(decodeStoredSecrets(stored, env.settingsSecretKey));
  cached = parsed.success ? parsed.data : settingsSchema.parse({});
  if (!env.settingsSecretKey) {
    console.warn("[config] 未设置 SETTINGS_SECRET_KEY：凭据将以明文存入数据库，仅限本地开发");
  } else if ([...SECRET_KEYS].some((k) => typeof stored[k] === "string" && stored[k] && !isEncrypted(stored[k]))) {
    // 旧的明文凭据：启动时就地加密
    await writeSettings(cached);
    console.log("[config] 已把 settings 中的明文凭据加密存储");
  }
  return cached;
}

export function getSettings(): Settings {
  if (!cached) throw new Error("settings not loaded yet");
  return cached;
}

export type SettingsDiff = Record<string, { from: unknown; to: unknown }>;

/** 两份配置的差异（供 settings_updated 事件记录，便于把行为变化归因到具体改动） */
export function diffSettings(before: Settings, after: Settings): SettingsDiff {
  const out: SettingsDiff = {};
  for (const key of Object.keys(after) as (keyof Settings)[]) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    out[key] = SECRET_KEYS.has(key)
      ? { from: REDACTED, to: REDACTED }
      : { from: before[key], to: after[key] };
  }
  return out;
}

async function writeSettings(s: Settings) {
  const value = encodeSecretsForStorage(s, env.settingsSecretKey);
  await db
    .insert(schema.settings)
    .values({ key: SETTINGS_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value, updatedAt: new Date() },
    });
}

export async function saveSettings(patch: unknown): Promise<Settings> {
  const merged = mergeSettingsPatch(cached ?? settingsSchema.parse({}), (patch ?? {}) as Record<string, unknown>);
  await writeSettings(merged);
  cached = merged;
  return merged;
}
