/**
 * diskGuard 的纯决策逻辑（无 IO，可单测）。
 *
 * 释放记账模型：删除下发后立刻把预计释放量记入台账（"待到账"），有效剩余 = 实测 + 未到账释放，
 * 缺口按有效剩余计算，因此不必等 qBittorrent 的空间数字露头就能继续按缺口补删。
 * 到账核对不看"空间涨了没"，而是把期间的并发下载写入扣掉：
 *   到账量 = (实测剩余 − 起点剩余) + (会话累计下载 − 起点累计下载)
 * 确认窗口到期后仍未到账超过容差，才是异常（释放不可见 / 删除未被 qBittorrent 执行），
 * 异常态停止继续删除并阻断新增下载，到账追上后自动解除。
 * 新增下载门控同样按有效剩余：记账释放覆盖缺口（RECLAIMING）即视为已释放、放行加种，
 * 不等 qBittorrent 的空间数字刷新；释放是否真到账交给上面的对账，没到账再转异常态阻断。
 */

const GB = 1024 ** 3;

export type PressureState = "HEALTHY" | "PRESSURE" | "RECLAIMING" | "BLOCKED" | "UNKNOWN";

export type AnomalyReason = "release_not_observed" | "delete_not_confirmed";

/** 一次磁盘观测：剩余空间 + 会话累计下载字节（用于扣除并发写入） */
export interface DiskObservation {
  at: number;
  freeBytes: number;
  /** qBittorrent maindata server_state.dl_info_data；字段缺失时 null（退化为不扣写入） */
  downloadedBytes: number | null;
}

/** 一条已下发的删除（释放先记账，事后核对） */
export interface LedgerEntry {
  infoHash: string;
  name: string;
  deletedAt: number;
  reclaimableBytes: number;
  /** qBittorrent 已不再持有该种子 */
  gone: boolean;
}

export interface ReleaseLedger {
  /** 记账起点：此后所有释放都相对这次观测核对 */
  base: DiskObservation;
  entries: LedgerEntry[];
}

export interface LedgerSettlement {
  /** 台账记入的释放合计 */
  creditedBytes: number;
  /** 自起点以来实际观测到的释放（剩余变化 + 期间下载写入，钳 ≥ 0） */
  landedBytes: number;
  /** 尚未在实测中体现的释放，用于计算有效剩余 */
  unreflectedBytes: number;
  /** 已过确认窗口的条目记账合计 */
  dueBytes: number;
  /** 已过确认窗口却仍未到账的量 */
  dueUnconfirmedBytes: number;
  toleranceBytes: number;
  anomaly: AnomalyReason | null;
  /** 全部条目已到期、已确认消失且到账在容差内：可以清账重置起点 */
  settled: boolean;
}

export interface SettleOptions {
  /** 确认窗口：删除下发后多久之内不要求到账 */
  windowMs: number;
  /** 最近约一个 qBittorrent 空间刷新周期内的下载写入量（其空间数字最多滞后这么多） */
  recentWriteBytes: number;
  /** 本 tick 是否成功向 qBittorrent 核实过条目是否仍存在；失败时不据此判异常 */
  presenceChecked: boolean;
}

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
 * 新增下载写入（加种 / 恢复下载）是否允许。
 * HEALTHY：实测 ≥ 阈值；RECLAIMING：实测 < 阈值但记账释放已覆盖缺口，删除大多即时生效、
 * 只是 qBittorrent 刷新滞后，先按已释放放行，事后由台账对账（扣除期间写入）。
 * PRESSURE（缺口未覆盖）、BLOCKED（未到账 / 删除未确认 / 规划不可行）、UNKNOWN（观测失效）阻断。
 */
export function additionAllowed(state: PressureState): boolean {
  return state === "HEALTHY" || state === "RECLAIMING";
}

/** 到账容差：预计释放本身是按进度折算的低置信估计，再加上 qBittorrent 空间数字的刷新滞后 */
export function releaseTolerance(dueBytes: number, recentWriteBytes: number): number {
  return Math.max(1 * GB, 0.2 * dueBytes) + Math.max(0, recentWriteBytes);
}

function sumBytes(entries: LedgerEntry[]): number {
  return entries.reduce((s, e) => s + e.reclaimableBytes, 0);
}

/** 起点与当前观测之间的下载写入量；任一侧缺字段则视为 0（无法扣除） */
export function writtenSince(base: DiskObservation, obs: DiskObservation): number {
  if (base.downloadedBytes === null || obs.downloadedBytes === null) return 0;
  return Math.max(0, obs.downloadedBytes - base.downloadedBytes);
}

/** 会话计数回退（qBittorrent 重启）：累计下载小于起点 */
export function counterReset(base: DiskObservation, obs: DiskObservation): boolean {
  return base.downloadedBytes !== null && obs.downloadedBytes !== null && obs.downloadedBytes < base.downloadedBytes;
}

export function settleLedger(ledger: ReleaseLedger, obs: DiskObservation, now: number, opts: SettleOptions): LedgerSettlement {
  const creditedBytes = sumBytes(ledger.entries);
  const landedBytes = Math.max(0, obs.freeBytes - ledger.base.freeBytes + writtenSince(ledger.base, obs));
  const unreflectedBytes = Math.max(0, creditedBytes - landedBytes);

  const due = ledger.entries.filter((e) => now - e.deletedAt >= opts.windowMs);
  const dueBytes = sumBytes(due);
  const dueUnconfirmedBytes = Math.max(0, dueBytes - landedBytes);
  const toleranceBytes = releaseTolerance(dueBytes, opts.recentWriteBytes);

  // 写入无法扣除（缺 dl_info_data）时并发下载会把释放完全掩盖，"未到账"不可判定，只核实种子是否消失
  const writeAccounting = ledger.base.downloadedBytes !== null && obs.downloadedBytes !== null;

  let anomaly: AnomalyReason | null = null;
  if (opts.presenceChecked && due.some((e) => !e.gone)) anomaly = "delete_not_confirmed";
  else if (writeAccounting && dueUnconfirmedBytes > toleranceBytes) anomaly = "release_not_observed";

  const settled =
    ledger.entries.length > 0 &&
    due.length === ledger.entries.length &&
    ledger.entries.every((e) => e.gone) &&
    anomaly === null;

  return {
    creditedBytes,
    landedBytes,
    unreflectedBytes,
    dueBytes,
    dueUnconfirmedBytes,
    toleranceBytes,
    anomaly,
    settled,
  };
}

/**
 * qBittorrent 重启后会话计数归零，同时其重启前的删除必然已经落盘：
 * 已确认消失的条目视为到账丢弃，起点重置到当前观测；未确认的条目保留继续核实。
 */
export function rebaseAfterCounterReset(ledger: ReleaseLedger, obs: DiskObservation): ReleaseLedger {
  return { base: obs, entries: ledger.entries.filter((e) => !e.gone) };
}

/** 清账：全部到账后把起点移到当前观测，避免长压力事件里的估计误差累积 */
export function rebaseSettled(obs: DiskObservation): ReleaseLedger {
  return { base: obs, entries: [] };
}
