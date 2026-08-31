import { describe, expect, test } from "bun:test";
import { planEviction, type EvictionCandidate } from "./evictionPlanner";

const GiB = 1024 ** 3;

function cand(partial: Partial<EvictionCandidate> & { id: number }): EvictionCandidate {
  return {
    infoHash: `hash-${partial.id}`,
    name: `t-${partial.id}`,
    lossValue: 1,
    reclaimableBytes: GiB,
    protectedByAge: false,
    legacyScore: 0.5,
    ...partial,
  };
}

describe("planEviction", () => {
  test("§9.4 反例：不只按密度——删小而够用的 B，不删大而低密度的 A", () => {
    // 需要 10 GiB。A: 释放 100 损失 10（密度 0.10）；B: 释放 10 损失 2（密度 0.20）
    const A = cand({ id: 1, lossValue: 10, reclaimableBytes: 100 * GiB });
    const B = cand({ id: 2, lossValue: 2, reclaimableBytes: 10 * GiB });
    const plan = planEviction([A, B], 10 * GiB, "bytes");
    expect(plan.status).toBe("feasible");
    expect(plan.chosen.map((c) => c.id)).toEqual([2]);
    expect(plan.expectedTotalLoss).toBe(2);
  });

  test("单项覆盖：多个小种组合损失更高时选单个大种", () => {
    const big = cand({ id: 1, lossValue: 3, reclaimableBytes: 12 * GiB });
    const s1 = cand({ id: 2, lossValue: 2, reclaimableBytes: 4 * GiB });
    const s2 = cand({ id: 3, lossValue: 2, reclaimableBytes: 4 * GiB });
    const s3 = cand({ id: 4, lossValue: 2, reclaimableBytes: 4 * GiB });
    const plan = planEviction([big, s1, s2, s3], 10 * GiB, "bytes");
    expect(plan.chosen.map((c) => c.id)).toEqual([1]);
  });

  test("多个小种组合优于昂贵的单项覆盖", () => {
    const big = cand({ id: 1, lossValue: 100, reclaimableBytes: 20 * GiB });
    const s1 = cand({ id: 2, lossValue: 1, reclaimableBytes: 6 * GiB });
    const s2 = cand({ id: 3, lossValue: 1, reclaimableBytes: 6 * GiB });
    const plan = planEviction([big, s1, s2], 10 * GiB, "bytes");
    expect(plan.chosen.map((c) => c.id).sort()).toEqual([2, 3]);
    expect(plan.expectedTotalLoss).toBe(2);
  });

  test("去冗余：密度顺序里多拿的项被剔除", () => {
    // 密度：D2 (0.05) 先于 D1 (0.1)，前缀 [D2, D1] 覆盖后 D2 冗余
    const D1 = cand({ id: 1, lossValue: 1, reclaimableBytes: 10 * GiB });
    const D2 = cand({ id: 2, lossValue: 0.1, reclaimableBytes: 2 * GiB });
    const plan = planEviction([D1, D2], 10 * GiB, "bytes");
    expect(plan.chosen.map((c) => c.id)).toEqual([1]);
  });

  test("候选合计不足 → insufficient_reclaim，不产出部分删除集合", () => {
    const a = cand({ id: 1, reclaimableBytes: 2 * GiB });
    const plan = planEviction([a], 10 * GiB, "bytes");
    expect(plan.status).toBe("insufficient_reclaim");
    expect(plan.chosen).toEqual([]);
  });

  test("零可释放候选被排除；全部无效 → no_safe_candidates", () => {
    const zero = cand({ id: 1, reclaimableBytes: 0 });
    const bad = cand({ id: 2, lossValue: NaN });
    const plan = planEviction([zero, bad], GiB, "bytes");
    expect(plan.status).toBe("no_safe_candidates");
    expect(plan.exclusions).toContainEqual({ id: 1, reason: "zero_reclaim" });
    expect(plan.exclusions).toContainEqual({ id: 2, reason: "invalid_value" });
  });

  test("无效缺口 → invalid_input", () => {
    expect(planEviction([cand({ id: 1 })], 0, "bytes").status).toBe("invalid_input");
    expect(planEviction([cand({ id: 1 })], NaN, "bytes").status).toBe("invalid_input");
  });

  test("保护期候选默认避开", () => {
    const prot = cand({ id: 1, lossValue: 0.01, reclaimableBytes: 20 * GiB, protectedByAge: true });
    const norm = cand({ id: 2, lossValue: 5, reclaimableBytes: 20 * GiB });
    const plan = planEviction([prot, norm], 10 * GiB, "bytes");
    expect(plan.chosen.map((c) => c.id)).toEqual([2]);
    expect(plan.usedProtected).toBe(false);
  });

  test("仅保护期候选能覆盖缺口时降级动用并标记（有限保护，不无限阻塞）", () => {
    const prot = cand({ id: 1, reclaimableBytes: 20 * GiB, protectedByAge: true });
    const plan = planEviction([prot], 10 * GiB, "bytes");
    expect(plan.status).toBe("feasible");
    expect(plan.usedProtected).toBe(true);
    expect(plan.chosen.map((c) => c.id)).toEqual([1]);
  });

  test("损失相等时超额释放更少优先", () => {
    const exact = cand({ id: 1, lossValue: 2, reclaimableBytes: 10 * GiB });
    const over = cand({ id: 2, lossValue: 2, reclaimableBytes: 50 * GiB });
    const plan = planEviction([exact, over], 10 * GiB, "bytes");
    expect(plan.chosen.map((c) => c.id)).toEqual([1]);
  });

  test("相同输入结果可重复（稳定 tie-break）", () => {
    const pool = [
      cand({ id: 3, lossValue: 1, reclaimableBytes: 5 * GiB }),
      cand({ id: 1, lossValue: 1, reclaimableBytes: 5 * GiB }),
      cand({ id: 2, lossValue: 1, reclaimableBytes: 5 * GiB }),
    ];
    const p1 = planEviction(pool, 8 * GiB, "bytes");
    const p2 = planEviction([...pool], 8 * GiB, "bytes");
    expect(p1.chosen.map((c) => c.id)).toEqual(p2.chosen.map((c) => c.id));
  });

  test("小规模穷举对照：启发式达到模型内最优（§15.3）", () => {
    const pool = [
      cand({ id: 1, lossValue: 4, reclaimableBytes: 7 * GiB }),
      cand({ id: 2, lossValue: 3, reclaimableBytes: 5 * GiB }),
      cand({ id: 3, lossValue: 2, reclaimableBytes: 4 * GiB }),
      cand({ id: 4, lossValue: 6, reclaimableBytes: 9 * GiB }),
      cand({ id: 5, lossValue: 1, reclaimableBytes: 2 * GiB }),
      cand({ id: 6, lossValue: 5, reclaimableBytes: 11 * GiB }),
    ];
    const need = 10 * GiB;
    // 穷举全部子集求模型内最优损失
    let best = Infinity;
    for (let mask = 1; mask < 1 << pool.length; mask++) {
      let reclaim = 0;
      let loss = 0;
      for (let i = 0; i < pool.length; i++) {
        if (mask & (1 << i)) {
          reclaim += pool[i]!.reclaimableBytes;
          loss += pool[i]!.lossValue;
        }
      }
      if (reclaim >= need && loss < best) best = loss;
    }
    const plan = planEviction(pool, need, "bytes");
    expect(plan.status).toBe("feasible");
    expect(plan.expectedTotalLoss).toBe(best);
  });

  test("执行顺序按损失密度升序（最便宜的空间先删，恢复即停时损失最小）", () => {
    const a = cand({ id: 1, lossValue: 4, reclaimableBytes: 5 * GiB }); // 密度 0.8
    const b = cand({ id: 2, lossValue: 1, reclaimableBytes: 5 * GiB }); // 密度 0.2
    const plan = planEviction([a, b], 10 * GiB, "bytes");
    expect(plan.chosen.map((c) => c.id)).toEqual([2, 1]);
    expect(plan.chosen[0]!.evictionRank).toBe(1);
  });
});
