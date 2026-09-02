import { describe, expect, test } from "bun:test";
import { decideSettle, resolveObservedState, type PendingDelete } from "./diskGuardPolicy";

const GB = 1024 ** 3;
const T = 10 * GB;

describe("resolveObservedState", () => {
  test("观测失效 → UNKNOWN，无论之前是什么", () => {
    for (const prev of ["HEALTHY", "PRESSURE", "RECLAIMING", "BLOCKED", "UNKNOWN"] as const) {
      expect(resolveObservedState(prev, null, null, T)).toBe("UNKNOWN");
      expect(resolveObservedState(prev, "deletion_limit", null, T)).toBe("UNKNOWN");
    }
  });

  test("熔断跨 UNKNOWN 保持：blockedReason 仍在，观测恢复后回到 BLOCKED 而非 PRESSURE", () => {
    expect(resolveObservedState("UNKNOWN", "delete_not_confirmed", 5 * GB, T)).toBe("BLOCKED");
    expect(resolveObservedState("UNKNOWN", "deletion_limit", 0, T)).toBe("BLOCKED");
  });

  test("熔断中观测到恢复：状态仍报 BLOCKED，由 tick 的 markRecovered 清账", () => {
    expect(resolveObservedState("BLOCKED", "deletion_limit", 20 * GB, T)).toBe("BLOCKED");
    expect(resolveObservedState("UNKNOWN", "deletion_limit", 20 * GB, T)).toBe("BLOCKED");
  });

  test("无熔断：按阈值分 HEALTHY / PRESSURE，RECLAIMING 不被观测路径覆盖", () => {
    expect(resolveObservedState("UNKNOWN", null, 20 * GB, T)).toBe("HEALTHY");
    expect(resolveObservedState("HEALTHY", null, 9 * GB, T)).toBe("PRESSURE");
    expect(resolveObservedState("PRESSURE", null, T, T)).toBe("HEALTHY");
    expect(resolveObservedState("RECLAIMING", null, 9 * GB, T)).toBe("RECLAIMING");
  });
});

describe("decideSettle", () => {
  const timeout = 60_000;
  const p: PendingDelete = {
    infoHash: "abc",
    name: "x",
    deletedAt: 1_000_000,
    freeAtDelete: 9 * GB,
    reclaimableBytes: 2 * GB,
  };

  test("种子仍在 qBittorrent：超时前等待，超时后熔断 delete_not_confirmed", () => {
    expect(decideSettle(p, p.deletedAt + 10_000, 9 * GB, true, timeout)).toEqual({ kind: "wait" });
    expect(decideSettle(p, p.deletedAt + 59_999, 12 * GB, true, timeout)).toEqual({ kind: "wait" });
    expect(decideSettle(p, p.deletedAt + timeout, 9 * GB, true, timeout)).toEqual({
      kind: "trip",
      reason: "delete_not_confirmed",
    });
  });

  test("种子已消失且空间上涨：立即确认（快路径）", () => {
    expect(decideSettle(p, p.deletedAt + 5_000, 9 * GB + 1, false, timeout)).toEqual({
      kind: "confirmed",
      releaseObserved: true,
    });
  });

  test("种子已消失但空间未涨（并发下载抵消 / 配额钳零）：等满 settle 窗口后确认，不熔断", () => {
    expect(decideSettle(p, p.deletedAt + 30_000, 9 * GB, false, timeout)).toEqual({ kind: "wait" });
    expect(decideSettle(p, p.deletedAt + 30_000, 0, false, timeout)).toEqual({ kind: "wait" });
    expect(decideSettle(p, p.deletedAt + timeout, 9 * GB, false, timeout)).toEqual({
      kind: "confirmed",
      releaseObserved: false,
    });
    expect(decideSettle(p, p.deletedAt + timeout, 0, false, timeout)).toEqual({
      kind: "confirmed",
      releaseObserved: false,
    });
  });

  test("空间下降（下载写入超过释放）不算观测到释放，也不算异常", () => {
    expect(decideSettle(p, p.deletedAt + timeout, 7 * GB, false, timeout)).toEqual({
      kind: "confirmed",
      releaseObserved: false,
    });
  });
});
