import { describe, expect, test } from "bun:test";
import type { FreeTorrent } from "../pt/types";
import { planCandidateWrite, type CandidateObservation } from "./discoverLog";

const at = (iso: string) => new Date(iso);

function ft(extra: Partial<FreeTorrent> = {}): FreeTorrent {
  return {
    siteId: "mteam",
    torrentId: "123",
    name: "Some.Movie",
    sizeBytes: 10e9,
    freeEndTime: at("2026-09-25T12:00:00Z"),
    seeders: 5,
    leechers: 20,
    snatched: 3,
    category: "401",
    ...extra,
  };
}

type Existing = Parameters<typeof planCandidateWrite>[0] & object;

function existing(extra: Partial<Existing> = {}): Existing {
  return {
    id: 7,
    siteId: "mteam",
    siteTorrentId: "123",
    name: "Some.Movie",
    sizeBytes: 10e9,
    siteCategory: "401",
    freeEndTime: at("2026-09-25T12:00:00Z"),
    firstSeenAt: at("2026-09-24T08:00:00Z"),
    lastSeenAt: at("2026-09-24T08:00:00Z"),
    seenCount: 1,
    seeders: 5,
    leechers: 20,
    snatched: 3,
    lastSeeders: 5,
    lastLeechers: 20,
    lastSnatched: 3,
    decision: "filtered",
    reason: "太大 300.0GB",
    rank: null,
    addedAt: null,
    infoHash: null,
    ...extra,
  };
}

const obs = (decision: CandidateObservation["decision"], extra: Partial<CandidateObservation> = {}) => ({
  torrent: ft({ seeders: 9, leechers: 40, snatched: 11 }),
  decision,
  ...extra,
});

const now = at("2026-09-24T10:00:00Z");

describe("planCandidateWrite", () => {
  test("首次看到：新行，首次与最近特征相同，added 记入场时刻", () => {
    const w = planCandidateWrite(null, obs("added", { rank: 1, infoHash: "a".repeat(40) }), now);
    expect(w.kind).toBe("insert");
    if (w.kind !== "insert") return;
    expect(w.row).toMatchObject({
      siteId: "mteam",
      siteTorrentId: "123",
      siteCategory: "401",
      seeders: 9,
      lastSeeders: 9,
      snatched: 11,
      decision: "added",
      rank: 1,
      addedAt: now,
      infoHash: "a".repeat(40),
      seenCount: 1,
    });
  });

  test("同周期再次看到：只更新最近观测，保留首次特征，非终局决策被覆盖", () => {
    const w = planCandidateWrite(existing(), obs("ranked_out", { rank: 14 }), now);
    expect(w).toEqual({
      kind: "update",
      id: 7,
      set: {
        lastSeenAt: now,
        seenCount: 2,
        freeEndTime: at("2026-09-25T12:00:00Z"),
        lastSeeders: 9,
        lastLeechers: 40,
        lastSnatched: 11,
        decision: "ranked_out",
        reason: null,
        rank: 14,
      },
    });
  });

  test("已添加（终局）后再被评估为 filtered/seen 不覆盖决策", () => {
    const e = existing({ decision: "added", addedAt: at("2026-09-24T08:00:00Z"), infoHash: "b".repeat(40) });
    for (const d of ["filtered", "seen"] as const) {
      const w = planCandidateWrite(e, obs(d, { reason: "free 剩余 1.0h < 24h" }), now);
      expect(w.kind).toBe("update");
      if (w.kind !== "update") return;
      expect(w.set.decision).toBeUndefined();
      expect(w.set.addedAt).toBeUndefined();
      expect(w.set.lastLeechers).toBe(40);
    }
  });

  test("seen 不改变非终局决策", () => {
    const w = planCandidateWrite(existing({ decision: "deferred" }), obs("seen"), now);
    expect(w.kind === "update" && w.set.decision).toBeUndefined();
  });

  test("暂缓后在同周期被添加：决策更新并记入场时刻", () => {
    const w = planCandidateWrite(existing({ decision: "deferred", rank: 2 }), obs("added", { rank: 1, infoHash: "c".repeat(40) }), now);
    expect(w.kind === "update" && w.set).toMatchObject({ decision: "added", addedAt: now, rank: 1, infoHash: "c".repeat(40) });
  });

  test("旧周期截止已过、以更晚截止再次 free：新周期新行", () => {
    const e = existing({ decision: "added", freeEndTime: at("2026-09-24T06:00:00Z") });
    const w = planCandidateWrite(e, { torrent: ft({ freeEndTime: at("2026-09-26T00:00:00Z") }), decision: "seen" }, now);
    expect(w.kind).toBe("insert");
  });

  test("周期内延期：同一行，更新截止时间", () => {
    const w = planCandidateWrite(existing(), { torrent: ft({ freeEndTime: at("2026-09-27T00:00:00Z") }), decision: "filtered" }, now);
    expect(w.kind === "update" && w.set.freeEndTime).toEqual(at("2026-09-27T00:00:00Z"));
  });
});
