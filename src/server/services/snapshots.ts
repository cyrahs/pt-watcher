import { desc, lt } from "drizzle-orm";
import { db, schema } from "../db";

export type SnapshotRow = typeof schema.torrentSnapshots.$inferInsert;

/**
 * 按墙钟对齐的间隔桶判定是否该落快照：上次快照所在桶之后的首轮 reconcile 落一次。
 * 对齐桶而不是"距上次满间隔"，避免 reconcile 的 jitter 让快照时刻逐次漂移。
 */
export function snapshotDue(last: Date | null, now: Date, intervalSec: number): boolean {
  if (!last) return true;
  const ms = intervalSec * 1000;
  return Math.floor(now.getTime() / ms) > Math.floor(last.getTime() / ms);
}

export async function lastSnapshotAt(): Promise<Date | null> {
  const rows = await db
    .select({ ts: schema.torrentSnapshots.ts })
    .from(schema.torrentSnapshots)
    .orderBy(desc(schema.torrentSnapshots.ts))
    .limit(1);
  return rows[0]?.ts ?? null;
}

// 单条 INSERT 的参数上限是 65535，按行分批
const INSERT_CHUNK = 1000;

/** 写入一批快照，并按保留天数清理过期快照（retentionDays=0 不清理） */
export async function recordSnapshots(
  rows: SnapshotRow[],
  now: Date,
  retentionDays: number,
): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await db.insert(schema.torrentSnapshots).values(rows.slice(i, i + INSERT_CHUNK));
  }
  if (retentionDays > 0) {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
    await db.delete(schema.torrentSnapshots).where(lt(schema.torrentSnapshots.ts, cutoff));
  }
}
