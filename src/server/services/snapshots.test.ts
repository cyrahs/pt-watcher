import { describe, expect, test } from "bun:test";
import { snapshotDue, torrentSnapshotBatch } from "./snapshots";

const H = 3600;
const at = (iso: string) => new Date(iso);

describe("snapshotDue", () => {
  test("从未落过快照时立即落", () => {
    expect(snapshotDue(null, at("2026-09-24T10:17:00Z"), H)).toBe(true);
  });

  test("同一间隔桶内不重复落", () => {
    expect(snapshotDue(at("2026-09-24T10:00:40Z"), at("2026-09-24T10:59:59Z"), H)).toBe(false);
  });

  test("跨入下一个桶的首轮即落，不要求距上次满一个间隔", () => {
    expect(snapshotDue(at("2026-09-24T10:58:00Z"), at("2026-09-24T11:00:30Z"), H)).toBe(true);
  });

  test("停机跨过多个桶后恢复时落一次", () => {
    expect(snapshotDue(at("2026-09-24T10:00:40Z"), at("2026-09-24T15:20:00Z"), H)).toBe(true);
  });

  test("时钟回拨（上次快照在未来）时不落", () => {
    expect(snapshotDue(at("2026-09-24T12:00:40Z"), at("2026-09-24T11:30:00Z"), H)).toBe(false);
  });
});

type Row = Parameters<typeof torrentSnapshotBatch>[0][number];

function row(id: number, sampledAt: string | null, extra: Partial<Row> = {}): Row {
  return {
    id,
    infoHash: String(id).padStart(40, "0"),
    siteId: null,
    siteTorrentId: null,
    name: `t${id}`,
    sizeBytes: 1000,
    category: "pt-watcher",
    state: "completed",
    addedByWatcher: true,
    freeEndTime: null,
    upEma: 12.5,
    lastUploadedBytes: 0,
    lastDownloadedBytes: 0,
    totalUploadedBytes: 500 * id,
    totalDownloadedBytes: 1000,
    ratio: 0.5,
    progress: 1,
    seeders: 3,
    leechers: 1,
    qbitPopularity: 0,
    score: 0,
    emaInitialized: true,
    expectedUploadBytes: 1_080_000,
    predictionKind: "rate_proxy",
    predictedAt: null,
    downloadBlock: null,
    addedAt: at("2026-09-20T00:00:00Z"),
    statSampledAt: sampledAt ? at(sampledAt) : null,
    untrackedAt: null,
    deletedAt: null,
    ...extra,
  };
}

const opts = (now: string, lastTs: string | null) => ({
  now: at(now),
  lastTs: lastTs ? at(lastTs) : null,
  intervalSec: H,
  maxAgeMs: 300_000,
  horizonSec: 86_400,
});

describe("torrentSnapshotBatch", () => {
  test("ts 取采样时刻，字段来自 reconcile 落库值", () => {
    const batch = torrentSnapshotBatch(
      [row(1, "2026-09-24T11:00:10Z")],
      opts("2026-09-24T11:01:00Z", "2026-09-24T10:00:10Z"),
    );
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({
      ts: at("2026-09-24T11:00:10Z"),
      torrentId: 1,
      totalUploadedBytes: 500,
      upEma: 12.5,
      expectedUploadBytes: 1_080_000,
      predictionKind: "rate_proxy",
      predictionHorizonSec: 86_400,
    });
  });

  test("EMA 未初始化记为 null", () => {
    const [snap] = torrentSnapshotBatch(
      [row(1, "2026-09-24T11:00:10Z", { emaInitialized: false })],
      opts("2026-09-24T11:01:00Z", null),
    );
    expect(snap!.upEma).toBeNull();
  });

  test("最新采样仍在上次快照的桶内时不落", () => {
    expect(
      torrentSnapshotBatch([row(1, "2026-09-24T10:40:00Z")], opts("2026-09-24T10:41:00Z", "2026-09-24T10:00:10Z")),
    ).toEqual([]);
  });

  test("采样过期（reconcile 停摆）时不落", () => {
    expect(
      torrentSnapshotBatch([row(1, "2026-09-24T10:50:00Z")], opts("2026-09-24T11:30:00Z", "2026-09-24T10:00:10Z")),
    ).toEqual([]);
  });

  test("只收新鲜且晚于上次快照的采样，过期行与无采样行跳过", () => {
    const batch = torrentSnapshotBatch(
      [
        row(1, "2026-09-24T11:00:10Z"),
        row(2, "2026-09-24T10:30:00Z"), // 过期
        row(3, null),
        row(4, "2026-09-24T10:58:00Z"), // 新鲜，属于不同的采样
      ],
      opts("2026-09-24T11:01:00Z", "2026-09-24T10:00:10Z"),
    );
    expect(batch.map((b) => b.torrentId)).toEqual([1, 4]);
  });

  test("间隔短于采样周期时同一采样不重复记录", () => {
    const o = { ...opts("2026-09-24T11:02:30Z", "2026-09-24T11:00:10Z"), intervalSec: 60 };
    expect(torrentSnapshotBatch([row(1, "2026-09-24T11:00:10Z")], o)).toEqual([]);
  });
});
