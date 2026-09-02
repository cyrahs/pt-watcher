/**
 * diskGuard 的纯决策逻辑（无 IO，可单测）。
 */

export type PressureState = "HEALTHY" | "PRESSURE" | "RECLAIMING" | "BLOCKED" | "UNKNOWN";

/** 一次已下发、尚未确认的删除 */
export interface PendingDelete {
  infoHash: string;
  name: string;
  deletedAt: number;
  /** 删除前一刻的实测剩余空间 */
  freeAtDelete: number;
  reclaimableBytes: number;
}

export type SettleDecision =
  | { kind: "wait" }
  | { kind: "confirmed"; releaseObserved: boolean }
  | { kind: "trip"; reason: "delete_not_confirmed" };

/**
 * 观测更新后的状态解析（tick 之外的观测路径，以及 tick 的前半段共用）。
 * 熔断跨观测失效保持：只要 blockedReason 还在，观测恢复后就回到 BLOCKED，
 * 而不是因为中间经过 UNKNOWN 就退回 PRESSURE 并继续删除。
 * 恢复（free ≥ 阈值）时的清账由 tick 的 markRecovered 负责，这里只给状态。
 */
export function resolveObservedState(
  prev: PressureState,
  blockedReason: string | null,
  free: number | null,
  threshold: number,
): PressureState {
  if (free === null) return "UNKNOWN";
  if (blockedReason !== null) return "BLOCKED";
  if (prev === "RECLAIMING") return "RECLAIMING";
  return free >= threshold ? "HEALTHY" : "PRESSURE";
}

/**
 * 删除后的等待判定。
 * "释放已观测"的判据是 qBittorrent 已不再持有该种子（删除被确认），
 * 而不是剩余空间上涨：并发下载会抵消释放量、配额钳零时 statfs 恒为 0，
 * 这两种情况下空间不涨都不是删除失败。
 * 删除确认后仍给剩余空间一个 settle 窗口露头（qBittorrent 自身 30s 才刷新一次），
 * 这也把释放不可见时的删除节奏限制到每个 settle 窗口一次。
 * 只有超时后种子仍在 qBittorrent 里，才是真正的异常 → 熔断。
 */
export function decideSettle(
  pending: PendingDelete,
  now: number,
  free: number,
  stillPresent: boolean,
  settleTimeoutMs: number,
): SettleDecision {
  const elapsed = now - pending.deletedAt;
  if (stillPresent) {
    return elapsed < settleTimeoutMs ? { kind: "wait" } : { kind: "trip", reason: "delete_not_confirmed" };
  }
  if (free > pending.freeAtDelete) return { kind: "confirmed", releaseObserved: true };
  if (elapsed < settleTimeoutMs) return { kind: "wait" };
  return { kind: "confirmed", releaseObserved: false };
}
