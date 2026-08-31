/**
 * 保留价值估计（一期）：统一预测窗口内的预计上传字节。
 *
 * 原则（对应交接文稿 §7/§8）：
 * - 近期真实上传速率是主要证据（rate_proxy：EMA × 窗口）。
 * - 无有效速率的候选用全局样本先验（global_prior：同批有效速率的中位数），单位一致。
 * - 整批都没有有效速率时，退回明确标记的需求启发式（fallback_heuristic），
 *   此时 lossValue 是无量纲启发分，不得展示为预计上传字节。
 * - free 到期 / 未完成不把价值归零；不按状态给删除硬优先级。
 */

export type PredictionKind = "rate_proxy" | "global_prior" | "fallback_heuristic";

export interface ValueInput {
  id: number;
  /** 有效速率（bytes/s）；null = EMA 未初始化，无有效观测 */
  emaRate: number | null;
  seeders: number;
  leechers: number;
  state: string;
}

export interface ValueOutput {
  /** 预测窗口内预计上传字节；fallback_heuristic 模式下为 null */
  expectedUploadBytes: number | null;
  predictionKind: PredictionKind;
  /**
   * 删除损失代理，同一批内单位一致：
   * 字节模式下 = expectedUploadBytes；启发式模式下 = 无量纲需求分。
   */
  lossValue: number;
  /** low / medium：证据强弱的粗粒度标记，不是校准概率 */
  confidence: "low" | "medium";
}

/** 需求启发式：log1p 压缩重尾 */
export function demandHeuristic(leechers: number, seeders: number): number {
  const l = Number.isFinite(leechers) && leechers > 0 ? leechers : 0;
  const s = Number.isFinite(seeders) && seeders > 0 ? seeders : 0;
  return Math.log1p(l / (s + 1));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** 批量估计保留价值。unit 标明整批 lossValue 的单位。 */
export function estimateRetention(
  items: ValueInput[],
  horizonSec: number,
): { unit: "bytes" | "heuristic"; byId: Map<number, ValueOutput> } {
  const byId = new Map<number, ValueOutput>();
  const validRates = items
    .map((i) => i.emaRate)
    .filter((r): r is number => r !== null && Number.isFinite(r) && r >= 0);

  if (validRates.length === 0) {
    // 整批无有效观测 → 全批统一启发式，不混合单位
    for (const i of items) {
      const h = demandHeuristic(i.leechers, i.seeders);
      byId.set(i.id, {
        expectedUploadBytes: null,
        predictionKind: "fallback_heuristic",
        lossValue: h,
        confidence: "low",
      });
    }
    return { unit: "heuristic", byId };
  }

  const prior = median(validRates);
  for (const i of items) {
    const hasRate = i.emaRate !== null && Number.isFinite(i.emaRate) && i.emaRate >= 0;
    const rate = hasRate ? (i.emaRate as number) : prior;
    const expected = rate * horizonSec;
    byId.set(i.id, {
      expectedUploadBytes: expected,
      predictionKind: hasRate ? "rate_proxy" : "global_prior",
      lossValue: expected,
      // 下载中产生的上传未必在停止获取后持续 → 证据打折标记
      confidence: hasRate && i.state !== "downloading" ? "medium" : "low",
    });
  }
  return { unit: "bytes", byId };
}
