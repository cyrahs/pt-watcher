import { describe, expect, test } from "bun:test";
import { demandHeuristic, estimateRetention, type ValueInput } from "./value";

const HORIZON = 86400;

function item(partial: Partial<ValueInput> & { id: number }): ValueInput {
  return { emaRate: null, seeders: 0, leechers: 0, state: "completed", ...partial };
}

describe("estimateRetention", () => {
  test("有效速率 → 字节单位，expected = 速率 × 窗口，kind=rate_proxy", () => {
    const a = item({ id: 1, emaRate: 100 });
    const { unit, byId } = estimateRetention([a], HORIZON);
    expect(unit).toBe("bytes");
    expect(byId.get(1)!.expectedUploadBytes).toBe(100 * HORIZON);
    expect(byId.get(1)!.predictionKind).toBe("rate_proxy");
  });

  test("混合批次：无速率候选用全局中位数先验，单位一致，kind=global_prior", () => {
    const a = item({ id: 1, emaRate: 100 });
    const b = item({ id: 2, emaRate: 300 });
    const c = item({ id: 3, emaRate: null });
    const { unit, byId } = estimateRetention([a, b, c], HORIZON);
    expect(unit).toBe("bytes");
    expect(byId.get(3)!.predictionKind).toBe("global_prior");
    expect(byId.get(3)!.lossValue).toBe(200 * HORIZON); // median(100,300)=200
  });

  test("整批无有效速率 → 全批 fallback_heuristic，不混合单位", () => {
    const a = item({ id: 1, leechers: 50, seeders: 2 });
    const b = item({ id: 2, leechers: 1, seeders: 100 });
    const { unit, byId } = estimateRetention([a, b], HORIZON);
    expect(unit).toBe("heuristic");
    expect(byId.get(1)!.expectedUploadBytes).toBeNull();
    expect(byId.get(1)!.predictionKind).toBe("fallback_heuristic");
    expect(byId.get(1)!.lossValue).toBeGreaterThan(byId.get(2)!.lossValue);
  });

  test("free 过期不归零：高上传的到期停种价值高于低上传的正常种", () => {
    const expired = item({ id: 1, emaRate: 500, state: "stopped_free_expired" });
    const normal = item({ id: 2, emaRate: 10, state: "completed" });
    const { byId } = estimateRetention([expired, normal], HORIZON);
    expect(byId.get(1)!.lossValue).toBeGreaterThan(byId.get(2)!.lossValue);
  });

  test("高收益老种优于低收益新种（年龄不无条件压过实际上传）", () => {
    const old = item({ id: 1, emaRate: 1000 });
    const young = item({ id: 2, emaRate: 1 });
    const { byId } = estimateRetention([old, young], HORIZON);
    expect(byId.get(1)!.lossValue).toBeGreaterThan(byId.get(2)!.lossValue);
  });
});

describe("demandHeuristic", () => {
  test("log1p 压缩重尾且单调", () => {
    expect(demandHeuristic(100, 1)).toBeGreaterThan(demandHeuristic(10, 1));
    expect(demandHeuristic(1000, 0)).toBeLessThan(Math.log1p(1000) + 1e-9);
    expect(demandHeuristic(0, 10)).toBe(0);
  });

  test("异常输入不产生 NaN", () => {
    expect(Number.isFinite(demandHeuristic(NaN, -3))).toBe(true);
    expect(Number.isFinite(demandHeuristic(-1, NaN))).toBe(true);
  });
});
