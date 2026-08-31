import { describe, expect, test } from "bun:test";
import { passesFilters, rankCandidates } from "./discover";
import type { FreeTorrent } from "../pt/types";

const GB = 1024 ** 3;
const NOW = Date.parse("2026-08-28T00:00:00Z");

function torrent(partial: Partial<FreeTorrent>): FreeTorrent {
  return {
    siteId: "mteam",
    torrentId: "1",
    name: "t",
    sizeBytes: 10 * GB,
    freeEndTime: new Date(NOW + 48 * 3600_000),
    seeders: 1,
    leechers: 1,
    snatched: 0,
    ...partial,
  };
}

const base = { onlyTimeLimitedFree: true, minFreeHours: 24, minSizeGB: 0, maxSizeGB: 200 };

describe("passesFilters", () => {
  test("限时 free 且剩余充足 → 通过", () => {
    expect(passesFilters(torrent({}), base, NOW).ok).toBe(true);
  });

  test("不限时 free 在 onlyTimeLimitedFree 时被过滤", () => {
    const r = passesFilters(torrent({ freeEndTime: null }), base, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("不限时");
  });

  test("不限时 free 在关闭开关时通过", () => {
    const r = passesFilters(torrent({ freeEndTime: null }), { ...base, onlyTimeLimitedFree: false }, NOW);
    expect(r.ok).toBe(true);
  });

  test("剩余时间不足 minFreeHours 被过滤", () => {
    const r = passesFilters(torrent({ freeEndTime: new Date(NOW + 10 * 3600_000) }), base, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("free 剩余");
  });

  test("体积上下限", () => {
    expect(passesFilters(torrent({ sizeBytes: 500 * GB }), base, NOW).ok).toBe(false);
    expect(passesFilters(torrent({ sizeBytes: 1 * GB }), { ...base, minSizeGB: 2 }, NOW).ok).toBe(false);
    expect(passesFilters(torrent({ sizeBytes: 1 * GB }), { ...base, maxSizeGB: 0 }, NOW).ok).toBe(true);
  });
});

describe("rankCandidates", () => {
  test("需求为主：高需求排在低需求之前，即使低需求的 deadline 更紧", () => {
    const hot = torrent({ torrentId: "hot", leechers: 50, seeders: 2, freeEndTime: new Date(NOW + 72 * 3600_000) });
    const cold = torrent({ torrentId: "cold", leechers: 1, seeders: 100, freeEndTime: new Date(NOW + 25 * 3600_000) });
    expect(rankCandidates([cold, hot]).map((t) => t.torrentId)).toEqual(["hot", "cold"]);
  });

  test("需求同档时 free 截止时间升序作次级", () => {
    const late = torrent({ torrentId: "late", leechers: 0, seeders: 0, freeEndTime: new Date(NOW + 48 * 3600_000) });
    const soon = torrent({ torrentId: "soon", leechers: 0, seeders: 0, freeEndTime: new Date(NOW + 24 * 3600_000) });
    expect(rankCandidates([late, soon]).map((t) => t.torrentId)).toEqual(["soon", "late"]);
  });

  test("不限时 free 不被无条件排到最后：高需求不限时优先于低需求限时", () => {
    const unlimited = torrent({ torrentId: "unl", leechers: 80, seeders: 1, freeEndTime: null });
    const urgent = torrent({ torrentId: "urg", leechers: 0, seeders: 50, freeEndTime: new Date(NOW + 25 * 3600_000) });
    expect(rankCandidates([urgent, unlimited]).map((t) => t.torrentId)).toEqual(["unl", "urg"]);
  });

  test("同档内不限时排在有限期之后", () => {
    const unlimited = torrent({ torrentId: "unl", leechers: 0, seeders: 0, freeEndTime: null });
    const limited = torrent({ torrentId: "lim", leechers: 0, seeders: 0, freeEndTime: new Date(NOW + 48 * 3600_000) });
    expect(rankCandidates([unlimited, limited]).map((t) => t.torrentId)).toEqual(["lim", "unl"]);
  });
});
