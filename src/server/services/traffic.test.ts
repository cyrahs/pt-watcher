import { describe, expect, test } from "bun:test";
import { counterDelta, dayKey } from "./traffic";

describe("counterDelta", () => {
  test("正常增长返回差值", () => {
    expect(counterDelta(1500, 1000)).toBe(500);
  });

  test("无变化返回 0", () => {
    expect(counterDelta(1000, 1000)).toBe(0);
  });

  test("计数器重置（当前值小于上次）时把当前值当作增量", () => {
    expect(counterDelta(300, 1000)).toBe(300);
  });

  test("从 0 起步（新种子）计全部", () => {
    expect(counterDelta(1234, 0)).toBe(1234);
  });
});

describe("dayKey", () => {
  test("按本地时区格式化为 YYYY-MM-DD", () => {
    const d = new Date(2026, 7, 28, 23, 59, 59);
    expect(dayKey(d)).toBe("2026-08-28");
  });

  test("个位月份/日期补零", () => {
    expect(dayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});
