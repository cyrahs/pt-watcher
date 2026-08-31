/**
 * free 周期判定（交接文稿 §6.3）：seen 不再永久排除，只在同一 free 周期内防抖。
 *
 * 保守规则（无站点周期标识时的可判定近似）：
 * - 记录的周期截止时间尚未过去 → 一律同周期（延期/数据修正不创建新周期）；
 * - 已跨过记录的截止时间后再次观测到 free，且观测截止时间晚于记录值 → 新周期；
 * - 记录为不限时 free（无截止时间）→ 无周期边界，保守视为同周期（一期不重下）。
 */
export function isNewFreeCycle(
  recordedEnd: Date | null,
  observedEnd: Date | null,
  now: number,
): boolean {
  if (recordedEnd === null) return false;
  if (now <= recordedEnd.getTime()) return false;
  if (observedEnd === null) return true; // 周期已过后转为不限时 free：新授权
  return observedEnd.getTime() > recordedEnd.getTime();
}
