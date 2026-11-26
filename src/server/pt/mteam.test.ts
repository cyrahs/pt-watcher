import { describe, expect, test } from "bun:test";
import { effectiveFreeEnd, NO_DOWNLOAD_AUTHORITY, parseMtTime, vipWindowFromProfile, withVipWindow } from "./mteam";

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

describe("vipWindowFromProfile", () => {
  const now = Date.parse("2026-11-27T00:00:00Z");
  const profile = {
    authorities: ["USER", NO_DOWNLOAD_AUTHORITY],
    memberStatus: { vip: true, vipUntil: "2026-12-26 12:49:24" },
  };

  test("vip + 不计下载权限 + 未到期 → 截止时间（UTC+8 解析）", () => {
    expect(vipWindowFromProfile(profile, now)?.toISOString()).toBe("2026-12-26T04:49:24.000Z");
  });

  test("缺任一条件都不启用（保守只下 free）", () => {
    expect(vipWindowFromProfile({ ...profile, authorities: ["USER"] }, now)).toBeNull();
    expect(vipWindowFromProfile({ ...profile, memberStatus: { vip: false, vipUntil: "2026-12-26 12:49:24" } }, now)).toBeNull();
    expect(vipWindowFromProfile({ ...profile, memberStatus: { vip: true, vipUntil: null } }, now)).toBeNull();
    expect(vipWindowFromProfile(profile, Date.parse("2026-12-27T00:00:00Z"))).toBeNull();
    expect(vipWindowFromProfile(null, now)).toBeNull();
  });
});

describe("withVipWindow", () => {
  const vip = new Date("2026-12-26T00:00:00Z");
  const early = new Date("2026-11-29T00:00:00Z");
  const late = new Date("2027-01-10T00:00:00Z");

  test("不在 VIP 期：原样返回", () => {
    expect(withVipWindow(undefined, null)).toEqual({ end: undefined, vipOnly: false });
    expect(withVipWindow(early, null)).toEqual({ end: early, vipOnly: false });
  });

  test("VIP 期：非 free 也可下载，截止为 VIP 截止", () => {
    expect(withVipWindow(undefined, vip)).toEqual({ end: vip, vipOnly: true });
  });

  test("VIP 期：free 截止与 VIP 截止取较晚者，不限时 free 仍不限时", () => {
    expect(withVipWindow(early, vip)).toEqual({ end: vip, vipOnly: false });
    expect(withVipWindow(late, vip)).toEqual({ end: late, vipOnly: false });
    expect(withVipWindow(null, vip)).toEqual({ end: null, vipOnly: false });
  });
});
