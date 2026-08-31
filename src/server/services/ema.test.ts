import { describe, expect, test } from "bun:test";
import { emaAlpha, isValidInterval, updateRateEma } from "./ema";

const HALF_LIFE = 233;

describe("updateRateEma", () => {
  test("null 冷启动：第一条有效区间直接建立均线", () => {
    expect(updateRateEma(null, { deltaBytes: 1000, dtSec: 10 }, HALF_LIFE)).toBe(100);
  });

  test("0 是有效速率：已初始化的均线向 0 衰减，不被当成未初始化", () => {
    const v = updateRateEma(100, { deltaBytes: 0, dtSec: 60 }, HALF_LIFE);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(100);
  });

  test("dt = 半衰期且速率为 0 时，均线恰好减半", () => {
    const v = updateRateEma(100, { deltaBytes: 0, dtSec: HALF_LIFE }, HALF_LIFE);
    expect(v).toBeCloseTo(50, 9);
  });

  test("固定速率下拆分/合并时间区间结果一致", () => {
    const prev = 200;
    const rate = 40;
    const merged = updateRateEma(prev, { deltaBytes: rate * 300, dtSec: 300 }, HALF_LIFE);
    const step1 = updateRateEma(prev, { deltaBytes: rate * 120, dtSec: 120 }, HALF_LIFE);
    const step2 = updateRateEma(step1, { deltaBytes: rate * 180, dtSec: 180 }, HALF_LIFE);
    expect(step2).toBeCloseTo(merged, 6);
  });

  test("不等间隔：长区间比短区间更接近区间速率", () => {
    const short = updateRateEma(0, { deltaBytes: 100 * 10, dtSec: 10 }, HALF_LIFE);
    const long = updateRateEma(0, { deltaBytes: 100 * 1000, dtSec: 1000 }, HALF_LIFE);
    expect(long).toBeGreaterThan(short);
    expect(long).toBeLessThanOrEqual(100);
  });
});

describe("emaAlpha", () => {
  test("dt=半衰期 → alpha=0.5；dt→0 → alpha→0", () => {
    expect(emaAlpha(HALF_LIFE, HALF_LIFE)).toBeCloseTo(0.5, 9);
    expect(emaAlpha(0, HALF_LIFE)).toBe(0);
  });
});

describe("isValidInterval", () => {
  test("dt<=0、负增量、非有限值都无效", () => {
    expect(isValidInterval(0, 100)).toBe(false);
    expect(isValidInterval(-5, 100)).toBe(false);
    expect(isValidInterval(10, -1)).toBe(false);
    expect(isValidInterval(NaN, 100)).toBe(false);
    expect(isValidInterval(10, 0)).toBe(true);
    expect(isValidInterval(10, 100)).toBe(true);
  });
});
