import { describe, expect, test } from "bun:test";
import { downloadCounted } from "./vipGuard";

const GB = 1024 ** 3;

describe("downloadCounted（VIP 熔断）", () => {
  test("下载量增长超过容差才熔断", () => {
    expect(downloadCounted(0, 1 * GB, 2 * GB)).toBe(false);
    expect(downloadCounted(0, 3 * GB, 2 * GB)).toBe(true);
    expect(downloadCounted(10 * GB, 12.5 * GB, 2 * GB)).toBe(true);
  });

  test("没有基线或当前值时不熔断", () => {
    expect(downloadCounted(null, 100 * GB, 2 * GB)).toBe(false);
    expect(downloadCounted(0, null, 2 * GB)).toBe(false);
    expect(downloadCounted(0, undefined, 2 * GB)).toBe(false);
  });
});
