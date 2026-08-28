import type { Settings } from "../config";

export interface ScoreInput {
  upEma: number; // bytes/s 指数均线
  seeders: number;
  leechers: number;
  ratio: number;
  ageDays: number;
  qbitPopularity: number;
}

function minMaxNorm(values: number[]): (v: number) => number {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) return () => 0.5;
  return (v: number) => (v - min) / (max - min);
}

/**
 * 流行度综合评分（0~1 左右，越高越值得保留）。
 * 归一化在同批候选内做 min-max，因此分数只用于批内排序，不跨批比较。
 */
export function scoreBatch<T extends ScoreInput>(items: T[], s: Settings): Map<T, number> {
  const result = new Map<T, number>();
  if (items.length === 0) return result;

  const demand = (i: ScoreInput) => i.leechers / (i.seeders + 1);
  const normUp = minMaxNorm(items.map((i) => i.upEma));
  const normDemand = minMaxNorm(items.map(demand));
  const normRatio = minMaxNorm(items.map((i) => Math.min(i.ratio, 10)));
  const normPop = minMaxNorm(items.map((i) => i.qbitPopularity));

  for (const i of items) {
    const age = Math.exp(-Math.max(i.ageDays, 0) / s.ageHalfLifeDays);
    const score =
      s.weightUpload * normUp(i.upEma) +
      s.weightDemand * normDemand(demand(i)) +
      s.weightRatio * normRatio(Math.min(i.ratio, 10)) +
      s.weightAge * age +
      s.weightQbitPopularity * normPop(i.qbitPopularity);
    result.set(i, score);
  }
  return result;
}

/** 上传速度指数均线：alpha 越大越跟随当前值 */
export function updateEma(prev: number, current: number, alpha = 0.3): number {
  return prev === 0 ? current : alpha * current + (1 - alpha) * prev;
}
