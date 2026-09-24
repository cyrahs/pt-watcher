import { and, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db";
import type { FreeTorrent } from "../pt/types";
import { isNewFreeCycle } from "./freeCycle";

/**
 * 候选决策：
 * - added       已添加到 qBittorrent
 * - existing    本地已有（已有记录回填站点信息 / qBittorrent 受管分类中收养 / 非受管分类跳过），reason 区分
 * - filtered    未通过过滤条件，reason 为具体条件
 * - seen        同一 free 周期内已处理过（去重）
 * - ranked_out  通过过滤但名次超出本轮 maxAddPerRun
 * - deferred    磁盘压力/观测失效，本轮整体暂缓新增
 * - error       添加失败，reason 为错误信息
 */
export type CandidateDecision =
  | "added"
  | "existing"
  | "filtered"
  | "seen"
  | "ranked_out"
  | "deferred"
  | "error";

export interface CandidateObservation {
  torrent: FreeTorrent;
  decision: CandidateDecision;
  reason?: string | null;
  rank?: number | null;
  infoHash?: string | null;
}

type CandidateRow = typeof schema.discoverCandidates.$inferSelect;
type NewCandidateRow = typeof schema.discoverCandidates.$inferInsert;

/** 周期内的终局决策：之后的评估（去重、临近到期被过滤等）只更新观测，不覆盖决策 */
const STICKY: ReadonlySet<string> = new Set(["added", "existing"]);

export type CandidateWrite =
  | { kind: "insert"; row: NewCandidateRow }
  | { kind: "update"; id: number; set: Partial<NewCandidateRow> };

/**
 * 一次观测落到候选日志的写法（纯函数）：
 * 没有记录或已进入新的 free 周期 → 新行（首次特征 = 本次观测）；
 * 同一周期 → 更新最近观测与 free 截止，非终局决策被本次评估覆盖（"seen" 不改决策）。
 */
export function planCandidateWrite(
  existing: CandidateRow | null,
  obs: CandidateObservation,
  now: Date,
): CandidateWrite {
  const t = obs.torrent;
  if (!existing || isNewFreeCycle(existing.freeEndTime, t.freeEndTime, now.getTime())) {
    return {
      kind: "insert",
      row: {
        siteId: t.siteId,
        siteTorrentId: t.torrentId,
        name: t.name,
        sizeBytes: t.sizeBytes,
        siteCategory: t.category ?? null,
        freeEndTime: t.freeEndTime,
        firstSeenAt: now,
        lastSeenAt: now,
        seenCount: 1,
        seeders: t.seeders,
        leechers: t.leechers,
        snatched: t.snatched,
        lastSeeders: t.seeders,
        lastLeechers: t.leechers,
        lastSnatched: t.snatched,
        decision: obs.decision,
        reason: obs.reason ?? null,
        rank: obs.rank ?? null,
        addedAt: obs.decision === "added" ? now : null,
        infoHash: obs.infoHash ?? null,
      },
    };
  }
  const set: Partial<NewCandidateRow> = {
    lastSeenAt: now,
    seenCount: existing.seenCount + 1,
    freeEndTime: t.freeEndTime,
    lastSeeders: t.seeders,
    lastLeechers: t.leechers,
    lastSnatched: t.snatched,
  };
  if (!STICKY.has(existing.decision) && obs.decision !== "seen") {
    set.decision = obs.decision;
    set.reason = obs.reason ?? null;
    set.rank = obs.rank ?? null;
    if (obs.decision === "added") set.addedAt = now;
  }
  if (obs.infoHash && !existing.infoHash) set.infoHash = obs.infoHash;
  return { kind: "update", id: existing.id, set };
}

/** 把本轮全部观测写入候选日志（每个站点种子取最新一行做周期判定） */
export async function recordCandidates(all: CandidateObservation[], now: Date): Promise<void> {
  // 同一站点种子一轮只落一次（以最后一次评估为准），避免同批插入重复行
  const observations = [
    ...new Map(all.map((o) => [`${o.torrent.siteId}:${o.torrent.torrentId}`, o])).values(),
  ];
  if (observations.length === 0) return;
  const c = schema.discoverCandidates;
  const bySite = new Map<string, string[]>();
  for (const o of observations) {
    bySite.set(o.torrent.siteId, [...(bySite.get(o.torrent.siteId) ?? []), o.torrent.torrentId]);
  }
  const latest = new Map<string, CandidateRow>();
  for (const [siteId, ids] of bySite) {
    const rows = await db
      .select()
      .from(c)
      .where(and(eq(c.siteId, siteId), inArray(c.siteTorrentId, ids)))
      .orderBy(desc(c.id));
    for (const r of rows) {
      const key = `${r.siteId}:${r.siteTorrentId}`;
      if (!latest.has(key)) latest.set(key, r);
    }
  }

  const inserts: NewCandidateRow[] = [];
  for (const o of observations) {
    const w = planCandidateWrite(latest.get(`${o.torrent.siteId}:${o.torrent.torrentId}`) ?? null, o, now);
    if (w.kind === "insert") inserts.push(w.row);
    else await db.update(c).set(w.set).where(eq(c.id, w.id));
  }
  if (inserts.length > 0) await db.insert(c).values(inserts);
}
