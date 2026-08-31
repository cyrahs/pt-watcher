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
 * legacy 流行度综合评分（0~1 左右，越高越值得保留）。
 * 归一化在同批候选内做 min-max，分数只在批内可比。
 * 已不再是清理排序契约：仅用于规划器的对照方案与 UI 过渡展示（新价值模型见 services/value.ts）。
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
