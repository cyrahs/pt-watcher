/**
 * 按实际时间差的指数均线（真半衰期语义）。
 * 替代旧的固定 alpha=0.3：平滑强度不再随采样间隔漂移；
 * 未初始化用显式状态表达（0 是有效速率，不再复用 0 表示"未初始化"）。
 */

/** dt 秒后的混合系数：dt = halfLife 时旧值权重恰好衰减到 1/2 */
export function emaAlpha(dtSec: number, halfLifeSec: number): number {
  return 1 - Math.pow(2, -dtSec / halfLifeSec);
}

export interface RateSample {
  /** 区间上传字节增量（来自单调累计计数器差分） */
  deltaBytes: number;
  /** 区间时长（秒） */
  dtSec: number;
}

/**
 * 用一个有效采样区间更新速率 EMA。
 * prev = null 表示尚未初始化（第一条有效区间直接建立均线）。
 * 无效区间（dt<=0、增量为负=计数器重置）应由调用方跳过并重建基线，不要调用本函数。
 */
export function updateRateEma(
  prev: number | null,
  sample: RateSample,
  halfLifeSec: number,
): number {
  const rate = sample.deltaBytes / sample.dtSec;
  if (prev === null) return rate;
  const a = emaAlpha(sample.dtSec, halfLifeSec);
  return a * rate + (1 - a) * prev;
}

/** 采样区间是否有效（可用于速率计算） */
export function isValidInterval(dtSec: number, deltaBytes: number): boolean {
  return Number.isFinite(dtSec) && dtSec > 0 && Number.isFinite(deltaBytes) && deltaBytes >= 0;
}
