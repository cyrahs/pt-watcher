import { HTTPException } from "hono/http-exception";

// 查询参数解析：非法输入一律 400（经 api.onError 转成 { error }），不静默回退默认值

function bad(message: string): never {
  throw new HTTPException(400, { message });
}

/** 缺省用 def，超过 max 截断 */
export function parseLimit(raw: string | undefined, def: number, max: number): number {
  if (raw == null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) bad(`limit 必须是正整数: ${raw}`);
  return Math.min(n, max);
}

export function parseOffset(raw: string | undefined): number {
  if (raw == null || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) bad(`offset 必须是非负整数: ${raw}`);
  return n;
}

export function parsePositiveInt(name: string, raw: string | undefined): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) bad(`${name} 必须是正整数: ${raw}`);
  return n;
}

const DURATION_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/**
 * 时间参数：ISO 8601（如 2026-09-01T00:00:00Z），或相对当前的时长 30m / 24h / 7d（= now 往前推）。
 * 只接受以完整日期开头的 ISO 形式，避免 Date 宽松解析把 "2026" 之类的输入当成合法时间。
 */
export function parseTime(raw: string | undefined, now: Date = new Date()): Date | undefined {
  if (raw == null || raw === "") return undefined;
  const rel = /^(\d+)([mhd])$/.exec(raw);
  if (rel) return new Date(now.getTime() - Number(rel[1]) * DURATION_MS[rel[2] as keyof typeof DURATION_MS]);
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) bad(`时间须为 ISO 8601 或 30m/24h/7d 形式: ${raw}`);
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) bad(`无法解析的时间: ${raw}`);
  return d;
}

/** 逗号分隔列表；缺省或全空 = 不过滤 */
export function parseList(raw: string | undefined): string[] | undefined {
  if (raw == null) return undefined;
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export function parseIdList(name: string, raw: string | undefined): number[] | undefined {
  return parseList(raw)?.map((s) => parsePositiveInt(name, s)!);
}

export function parseEnum<T extends string>(
  name: string,
  raw: string | undefined,
  allowed: readonly T[],
  def: T,
): T {
  if (raw == null || raw === "") return def;
  if (!(allowed as readonly string[]).includes(raw)) {
    bad(`${name} 取值须为 ${allowed.join(" / ")}: ${raw}`);
  }
  return raw as T;
}

export function parseBool(name: string, raw: string | undefined): boolean | undefined {
  if (raw == null || raw === "") return undefined;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return bad(`${name} 须为 true / false: ${raw}`);
}

/** LIKE 模式转义（Postgres 默认转义符为反斜杠） */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export type TorrentRef = { id: number } | { infoHash: string };

/** 种子引用：数字 id，或 infohash（v1 40 位 / v2 64 位十六进制，大小写不敏感） */
export function parseTorrentRef(raw: string): TorrentRef {
  if (/^\d+$/.test(raw)) return { id: parsePositiveInt("id", raw)! };
  if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(raw)) return { infoHash: raw.toLowerCase() };
  return bad(`种子引用须为数字 id 或 infohash: ${raw}`);
}
