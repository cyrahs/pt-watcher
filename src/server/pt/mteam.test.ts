import { describe, expect, test } from "bun:test";
import { effectiveFreeEnd, parseMtTime } from "./mteam";

describe("parseMtTime", () => {
  test("parses UTC+8 timestamps", () => {
    const d = parseMtTime("2026-08-28 20:00:00");
    expect(d?.toISOString()).toBe("2026-08-28T12:00:00.000Z");
  });

  test("returns null on empty/invalid", () => {
    expect(parseMtTime(null)).toBeNull();
    expect(parseMtTime("")).toBeNull();
    expect(parseMtTime("garbage")).toBeNull();
  });
});

describe("effectiveFreeEnd", () => {
  test("non-free discount → undefined", () => {
    expect(effectiveFreeEnd({ discount: "NORMAL" })).toBeUndefined();
    expect(effectiveFreeEnd({ discount: "PERCENT_50" })).toBeUndefined();
    expect(effectiveFreeEnd(undefined)).toBeUndefined();
  });

  test("FREE with end time", () => {
    const end = effectiveFreeEnd({ discount: "FREE", discountEndTime: "2026-08-28 20:00:00" });
    expect(end?.toISOString()).toBe("2026-08-28T12:00:00.000Z");
  });

  test("FREE without end time → null (不限时)", () => {
    expect(effectiveFreeEnd({ discount: "FREE", discountEndTime: null })).toBeNull();
    expect(effectiveFreeEnd({ discount: "_2X_FREE" })).toBeNull();
  });

  test("mallSingleFree ONGOING 优先于 discount", () => {
    const end = effectiveFreeEnd({
      discount: "NORMAL",
      mallSingleFree: { status: "ONGOING", endDate: "2026-09-01 00:00:00" },
    });
    expect(end?.toISOString()).toBe("2026-08-31T16:00:00.000Z");
  });

  test("mallSingleFree 非 ONGOING 不生效", () => {
    expect(
      effectiveFreeEnd({ discount: "NORMAL", mallSingleFree: { status: "ENDED", endDate: "2026-09-01 00:00:00" } }),
    ).toBeUndefined();
  });
});
