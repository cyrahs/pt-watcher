import { describe, expect, test } from "bun:test";
import { isNewFreeCycle } from "./freeCycle";

const NOW = Date.parse("2026-08-30T00:00:00Z");
const d = (h: number) => new Date(NOW + h * 3600_000);

describe("isNewFreeCycle", () => {
  test("记录为不限时 free：无周期边界，保守视为同周期", () => {
    expect(isNewFreeCycle(null, d(100), NOW)).toBe(false);
  });

  test("记录周期尚未结束：延期只更新截止时间，不创建新周期", () => {
    expect(isNewFreeCycle(d(10), d(48), NOW)).toBe(false);
  });

  test("跨过记录截止时间后再次 free 且截止更晚 → 新周期", () => {
    expect(isNewFreeCycle(d(-10), d(48), NOW)).toBe(true);
  });

  test("跨过截止时间后转为不限时 free → 新授权", () => {
    expect(isNewFreeCycle(d(-10), null, NOW)).toBe(true);
  });

  test("跨过截止时间但观测截止不晚于记录（数据修正/缓存）→ 同周期", () => {
    expect(isNewFreeCycle(d(-10), d(-10), NOW)).toBe(false);
    expect(isNewFreeCycle(d(-10), d(-20), NOW)).toBe(false);
  });
});
