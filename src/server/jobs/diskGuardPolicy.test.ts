import { describe, expect, test } from "bun:test";
import {
  additionAllowed,
  counterReset,
  rebaseAfterCounterReset,
  releaseTolerance,
  resolveObservedState,
  settleLedger,
  type DiskObservation,
  type LedgerEntry,
  type ReleaseLedger,
} from "./diskGuardPolicy";

const GB = 1024 ** 3;
const T = 10 * GB;
const WINDOW = 90_000;

describe("resolveObservedState", () => {
  test("观测失效 → UNKNOWN，无论之前是什么", () => {
    for (const prev of ["HEALTHY", "PRESSURE", "RECLAIMING", "BLOCKED", "UNKNOWN"] as const) {
      expect(resolveObservedState(prev, null, null, T)).toBe("UNKNOWN");
      expect(resolveObservedState(prev, "release_not_observed", null, T)).toBe("UNKNOWN");
    }
  });

  test("熔断跨 UNKNOWN 保持：blockedReason 仍在，观测恢复后回到 BLOCKED 而非 PRESSURE", () => {
    expect(resolveObservedState("UNKNOWN", "delete_not_confirmed", 5 * GB, T)).toBe("BLOCKED");
    expect(resolveObservedState("UNKNOWN", "release_not_observed", 0, T)).toBe("BLOCKED");
  });

  test("熔断中观测到恢复：状态仍报 BLOCKED，由 tick 的 markRecovered 清账", () => {
    expect(resolveObservedState("BLOCKED", "release_not_observed", 20 * GB, T)).toBe("BLOCKED");
  });

  test("无熔断：按阈值分 HEALTHY / PRESSURE，RECLAIMING 不被观测路径覆盖", () => {
    expect(resolveObservedState("UNKNOWN", null, 20 * GB, T)).toBe("HEALTHY");
    expect(resolveObservedState("HEALTHY", null, 9 * GB, T)).toBe("PRESSURE");
    expect(resolveObservedState("PRESSURE", null, T, T)).toBe("HEALTHY");
    expect(resolveObservedState("RECLAIMING", null, 9 * GB, T)).toBe("RECLAIMING");
  });
});

describe("additionAllowed：新增下载门控", () => {
  test("HEALTHY 与 RECLAIMING 放行：记账释放覆盖缺口即视为已释放，不等 qBittorrent 刷新", () => {
    expect(additionAllowed("HEALTHY")).toBe(true);
    expect(additionAllowed("RECLAIMING")).toBe(true);
  });

  test("压力未覆盖、异常/规划不可行熔断、观测失效时阻断", () => {
    expect(additionAllowed("PRESSURE")).toBe(false);
    expect(additionAllowed("BLOCKED")).toBe(false);
    expect(additionAllowed("UNKNOWN")).toBe(false);
  });
});

function obs(at: number, freeBytes: number, downloadedBytes: number | null = 100 * GB): DiskObservation {
  return { at, freeBytes, downloadedBytes };
}

function entry(deletedAt: number, reclaimableBytes: number, gone = true, infoHash = "h"): LedgerEntry {
  return { infoHash, name: infoHash, deletedAt, reclaimableBytes, gone };
}

const opts = { windowMs: WINDOW, recentWriteBytes: 0, presenceChecked: true };

describe("settleLedger：释放记账与到账核对", () => {
  const t0 = 1_000_000;
  const base = obs(t0, 8 * GB);

  test("窗口内未到账：不算异常，全额计入有效剩余", () => {
    const ledger: ReleaseLedger = { base, entries: [entry(t0, 3 * GB)] };
    const st = settleLedger(ledger, obs(t0 + 5_000, 8 * GB), t0 + 5_000, opts);
    expect(st.anomaly).toBeNull();
    expect(st.unreflectedBytes).toBe(3 * GB);
    expect(st.dueBytes).toBe(0);
    expect(st.settled).toBe(false);
  });

  test("并发下载把空间涨幅抵消：用累计下载差分扣回写入后仍能确认到账", () => {
    const ledger: ReleaseLedger = { base, entries: [entry(t0, 3 * GB)] };
    // 释放 3GB 的同时下载写入 2.5GB → 实测只涨 0.5GB
    const later = obs(t0 + WINDOW, 8.5 * GB, 102.5 * GB);
    const st = settleLedger(ledger, later, t0 + WINDOW, opts);
    expect(st.landedBytes).toBe(3 * GB);
    expect(st.unreflectedBytes).toBe(0);
    expect(st.anomaly).toBeNull();
    expect(st.settled).toBe(true);
  });

  test("空间不升反降（写入 > 释放）也能到账，不误判", () => {
    const ledger: ReleaseLedger = { base, entries: [entry(t0, 2 * GB)] };
    const later = obs(t0 + WINDOW, 7 * GB, 103 * GB); // 写入 3GB，释放 2GB → 净 -1GB
    const st = settleLedger(ledger, later, t0 + WINDOW, opts);
    expect(st.landedBytes).toBe(2 * GB);
    expect(st.anomaly).toBeNull();
  });

  test("到期未到账超过容差 → release_not_observed", () => {
    const ledger: ReleaseLedger = { base, entries: [entry(t0, 10 * GB)] };
    const later = obs(t0 + WINDOW, 8 * GB, 100 * GB); // 什么都没变
    const st = settleLedger(ledger, later, t0 + WINDOW, opts);
    expect(st.dueUnconfirmedBytes).toBe(10 * GB);
    expect(st.anomaly).toBe("release_not_observed");
    expect(st.settled).toBe(false);
  });

  test("到账差额在容差内（估计误差 + 刷新滞后）不算异常并可清账", () => {
    const ledger: ReleaseLedger = { base, entries: [entry(t0, 10 * GB)] };
    const later = obs(t0 + WINDOW, 16.5 * GB, 100 * GB); // 只到账 8.5GB，容差 max(1GB, 2GB)=2GB
    const st = settleLedger(ledger, later, t0 + WINDOW, opts);
    expect(st.anomaly).toBeNull();
    expect(st.settled).toBe(true);
    // 最近写入滞后也计入容差
    const tight = settleLedger(ledger, obs(t0 + WINDOW, 15 * GB, 100 * GB), t0 + WINDOW, opts);
    expect(tight.anomaly).toBe("release_not_observed");
    const withLag = settleLedger(ledger, obs(t0 + WINDOW, 15 * GB, 100 * GB), t0 + WINDOW, {
      ...opts,
      recentWriteBytes: 1.5 * GB,
    });
    expect(withLag.anomaly).toBeNull();
  });

  test("多条目：只有到期条目参与异常判定，未到期条目仍全额记账", () => {
    const ledger: ReleaseLedger = {
      base,
      entries: [entry(t0, 2 * GB, true, "a"), entry(t0 + 60_000, 5 * GB, true, "b")],
    };
    const now = t0 + WINDOW;
    const st = settleLedger(ledger, obs(now, 10 * GB, 100 * GB), now, opts); // 到账 2GB
    expect(st.dueBytes).toBe(2 * GB);
    expect(st.dueUnconfirmedBytes).toBe(0);
    expect(st.unreflectedBytes).toBe(5 * GB);
    expect(st.anomaly).toBeNull();
    expect(st.settled).toBe(false);
  });

  test("到期后种子仍被 qBittorrent 持有 → delete_not_confirmed；未核实成功时不据此判异常", () => {
    const ledger: ReleaseLedger = { base, entries: [entry(t0, 2 * GB, false)] };
    const later = obs(t0 + WINDOW, 10 * GB, 100 * GB);
    expect(settleLedger(ledger, later, t0 + WINDOW, opts).anomaly).toBe("delete_not_confirmed");
    expect(settleLedger(ledger, later, t0 + WINDOW, { ...opts, presenceChecked: false }).anomaly).toBeNull();
    // 窗口内仍在也只是等待
    expect(settleLedger(ledger, obs(t0 + 10_000, 8 * GB), t0 + 10_000, opts).anomaly).toBeNull();
  });

  test("缺 dl_info_data 时无法扣写入：不判 release_not_observed，仍核实种子消失", () => {
    const ledger: ReleaseLedger = { base: obs(t0, 8 * GB, null), entries: [entry(t0, 10 * GB)] };
    const st = settleLedger(ledger, obs(t0 + WINDOW, 8 * GB, null), t0 + WINDOW, opts);
    expect(st.anomaly).toBeNull();
    expect(st.unreflectedBytes).toBe(10 * GB);
  });

  test("异常态自愈：到账追上后同一台账不再报异常", () => {
    const ledger: ReleaseLedger = { base, entries: [entry(t0, 10 * GB)] };
    expect(settleLedger(ledger, obs(t0 + WINDOW, 8 * GB), t0 + WINDOW, opts).anomaly).toBe("release_not_observed");
    expect(settleLedger(ledger, obs(t0 + 2 * WINDOW, 18 * GB), t0 + 2 * WINDOW, opts).anomaly).toBeNull();
  });
});

describe("会话计数回退", () => {
  test("qBittorrent 重启：已确认消失的条目视为到账，起点重置，未确认条目保留", () => {
    const base = obs(0, 8 * GB, 100 * GB);
    const ledger: ReleaseLedger = { base, entries: [entry(0, 2 * GB, true, "a"), entry(0, 3 * GB, false, "b")] };
    const after = obs(10_000, 9 * GB, 1 * GB);
    expect(counterReset(base, after)).toBe(true);
    const rebased = rebaseAfterCounterReset(ledger, after);
    expect(rebased.base).toBe(after);
    expect(rebased.entries.map((e) => e.infoHash)).toEqual(["b"]);
  });
});

describe("releaseTolerance", () => {
  test("下限 1GB，按到期量 20% 放大，再加最近写入滞后", () => {
    expect(releaseTolerance(0, 0)).toBe(1 * GB);
    expect(releaseTolerance(10 * GB, 0)).toBe(2 * GB);
    expect(releaseTolerance(10 * GB, 0.5 * GB)).toBe(2.5 * GB);
  });
});
