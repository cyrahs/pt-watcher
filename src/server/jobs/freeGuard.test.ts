import { describe, expect, test } from "bun:test";
import { noDataPurgeDue } from "./freeGuard";

const H = 3600_000;
const NOW = Date.parse("2026-09-27T12:00:00Z");
const base = {
  state: "stopped_free_expired",
  sizeBytes: 10 * 1024 ** 3,
  progress: 0,
  freeEndTime: new Date(NOW - 30 * H),
};

describe("noDataPurgeDue", () => {
  test("阻断后无数据且 free 截止已超过 N 小时 → 删除", () => {
    expect(noDataPurgeDue(base, NOW, 24)).toBe(true);
  });

  test("free 截止未满 N 小时不删", () => {
    expect(noDataPurgeDue({ ...base, freeEndTime: new Date(NOW - 23 * H) }, NOW, 24)).toBe(false);
  });

  test("有数据的阻断种子交给清理规划，不删", () => {
    expect(noDataPurgeDue({ ...base, progress: 0.001 }, NOW, 24)).toBe(false);
  });

  test("进度极小但可释放取整为 0 视为无数据（与规划器 zero_reclaim 口径一致）", () => {
    expect(noDataPurgeDue({ ...base, sizeBytes: 100, progress: 0.001 }, NOW, 24)).toBe(true);
  });

  test("0 = 关闭；非阻断状态或无截止时间不删", () => {
    expect(noDataPurgeDue(base, NOW, 0)).toBe(false);
    expect(noDataPurgeDue({ ...base, state: "downloading" }, NOW, 24)).toBe(false);
    expect(noDataPurgeDue({ ...base, state: "completed", progress: 1 }, NOW, 24)).toBe(false);
    expect(noDataPurgeDue({ ...base, freeEndTime: null }, NOW, 24)).toBe(false);
  });
});
