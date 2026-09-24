import { describe, expect, test } from "bun:test";
import { snapshotDue } from "./snapshots";

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
