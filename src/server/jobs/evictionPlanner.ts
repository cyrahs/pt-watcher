/**
 * 纯清理规划器：给定候选快照和本次实测缺口，选出未来上传损失较小的删除集合。
 *
 * 近似目标（交接文稿 §9.1）：
 *   minimize Σ lossValue_i  s.t.  Σ reclaimableBytes_i >= needBytes
 *
 * 一期实现 §9.5：多启发式生成方案（legacy 对照 / 损失密度 / 剩余缺口修正 / 单项覆盖），
 * 去冗余 + 有界单项替换，最后统一比较（总损失 → 超额释放 → 数量 → 稳定 ID）。
 * 只声称在同一模型和已生成方案中选到较好结果，不保证全局最优。
 *
 * 本模块是纯函数：不读磁盘、不发网络请求、不写数据库。
 * 真实清理、dry-run 和 UI 预览共用它（§12.1）。
 */

export interface EvictionCandidate {
  id: number;
  infoHash: string;
  name: string;
  /** 删除损失代理（同一批内单位一致，见 value.ts） */
  lossValue: number;
  /** 预计释放字节（低置信度估计：按进度折算） */
  reclaimableBytes: number;
  /** 是否在新种探索保护期内（有界保护：无可行方案时降级动用并记录） */
  protectedByAge: boolean;
  /** legacy min-max 评分，仅用于对照方案 */
  legacyScore: number;
}

export interface EvictionPlanItem extends EvictionCandidate {
  evictionRank: number;
}

export type EvictionPlanStatus =
  | "feasible"
  | "no_safe_candidates"
  | "insufficient_reclaim"
  | "invalid_input";

export interface EvictionPlan {
  status: EvictionPlanStatus;
  needBytes: number;
  valueUnit: "bytes" | "heuristic";
  /** 按执行顺序排列（损失密度升序）；每次删除前仍须复核阈值 */
  chosen: EvictionPlanItem[];
  expectedTotalLoss: number;
  expectedTotalReclaim: number;
  expectedOvershoot: number;
  strategy: string;
  alternativesSummary: {
    strategy: string;
    totalLoss: number;
    totalReclaim: number;
    count: number;
  }[];
  /** 是否降级动用了保护期候选 */
  usedProtected: boolean;
  exclusions: { id: number; reason: string }[];
  reason?: string;
}

const LOSS_TOLERANCE = 1e-9;

function byIdAsc(a: EvictionCandidate, b: EvictionCandidate): number {
  return a.id - b.id;
}

function totalReclaim(items: EvictionCandidate[]): number {
  return items.reduce((s, i) => s + i.reclaimableBytes, 0);
}

function totalLoss(items: EvictionCandidate[]): number {
  return items.reduce((s, i) => s + i.lossValue, 0);
}

/** 取排好序的列表前缀直到覆盖缺口；覆盖不了返回 null */
function takeUntilCovered(sorted: EvictionCandidate[], need: number): EvictionCandidate[] | null {
  const out: EvictionCandidate[] = [];
  let covered = 0;
  for (const c of sorted) {
    out.push(c);
    covered += c.reclaimableBytes;
    if (covered >= need) return out;
  }
  return null;
}

/** 去冗余：从损失最大的开始，能去掉仍覆盖缺口的项就去掉 */
function pruneRedundant(items: EvictionCandidate[], need: number): EvictionCandidate[] {
  const kept = [...items];
  const byLossDesc = [...items].sort((a, b) => b.lossValue - a.lossValue || byIdAsc(a, b));
  for (const c of byLossDesc) {
    const without = kept.filter((k) => k.id !== c.id);
    if (totalReclaim(without) >= need) {
      kept.length = 0;
      kept.push(...without);
    }
  }
  return kept;
}

/** 有界单项替换：每个已选项尝试换成一个损失更小、仍能覆盖缺口的未选项（单轮） */
function singleSwapImprove(
  items: EvictionCandidate[],
  pool: EvictionCandidate[],
  need: number,
): EvictionCandidate[] {
  let current = [...items];
  const chosenIds = new Set(current.map((c) => c.id));
  const outside = pool.filter((c) => !chosenIds.has(c.id));
  for (const c of [...current].sort((a, b) => b.lossValue - a.lossValue || byIdAsc(a, b))) {
    const rest = current.filter((k) => k.id !== c.id);
    const restReclaim = totalReclaim(rest);
    let best: EvictionCandidate | null = null;
    for (const d of outside) {
      if (d.lossValue >= c.lossValue) continue;
      if (restReclaim + d.reclaimableBytes < need) continue;
      if (!best || d.lossValue < best.lossValue || (d.lossValue === best.lossValue && d.id < best.id)) {
        best = d;
      }
    }
    if (best) {
      current = [...rest, best];
      chosenIds.delete(c.id);
      chosenIds.add(best.id);
      const idx = outside.findIndex((o) => o.id === best!.id);
      outside.splice(idx, 1, c);
    }
  }
  return current;
}

function density(c: EvictionCandidate): number {
  return c.lossValue / c.reclaimableBytes;
}

/** 各启发式在同一候选池上生成方案；覆盖不了缺口的策略产出 null */
function generatePlans(
  pool: EvictionCandidate[],
  need: number,
): { strategy: string; items: EvictionCandidate[] }[] {
  const out: { strategy: string; items: EvictionCandidate[] }[] = [];

  // 1) legacy 对照：旧评分升序（已去掉 free 到期硬优先级）
  const legacy = takeUntilCovered(
    [...pool].sort((a, b) => a.legacyScore - b.legacyScore || byIdAsc(a, b)),
    need,
  );
  if (legacy) out.push({ strategy: "legacy_score_asc", items: legacy });

  // 2) 损失密度升序
  const dens = takeUntilCovered(
    [...pool].sort((a, b) => density(a) - density(b) || byIdAsc(a, b)),
    need,
  );
  if (dens) out.push({ strategy: "loss_density_asc", items: dens });

  // 3) 剩余缺口修正：每步按 loss / min(B, remainingNeed) 选择
  {
    const remainingPool = [...pool];
    const picked: EvictionCandidate[] = [];
    let remaining = need;
    while (remaining > 0 && remainingPool.length > 0) {
      let bestIdx = -1;
      let bestKey = Infinity;
      for (let i = 0; i < remainingPool.length; i++) {
        const c = remainingPool[i]!;
        const key = c.lossValue / Math.min(c.reclaimableBytes, remaining);
        if (key < bestKey || (key === bestKey && bestIdx >= 0 && c.id < remainingPool[bestIdx]!.id)) {
          bestKey = key;
          bestIdx = i;
        }
      }
      const chosen = remainingPool.splice(bestIdx, 1)[0]!;
      picked.push(chosen);
      remaining -= chosen.reclaimableBytes;
    }
    if (remaining <= 0) out.push({ strategy: "marginal_density", items: picked });
  }

  // 4) 单项覆盖：能独立覆盖缺口的候选中损失最低的一项
  const single = pool
    .filter((c) => c.reclaimableBytes >= need)
    .sort((a, b) => a.lossValue - b.lossValue || byIdAsc(a, b))[0];
  if (single) out.push({ strategy: "single_cover", items: [single] });

  return out;
}

export function planEviction(
  candidates: EvictionCandidate[],
  needBytes: number,
  valueUnit: "bytes" | "heuristic",
): EvictionPlan {
  const base = {
    needBytes,
    valueUnit,
    chosen: [] as EvictionPlanItem[],
    expectedTotalLoss: 0,
    expectedTotalReclaim: 0,
    expectedOvershoot: 0,
    strategy: "",
    alternativesSummary: [] as EvictionPlan["alternativesSummary"],
    usedProtected: false,
    exclusions: [] as { id: number; reason: string }[],
  };

  if (!Number.isFinite(needBytes) || needBytes <= 0) {
    return { ...base, status: "invalid_input", reason: `无效缺口: ${needBytes}` };
  }

  // 资格过滤：异常值明确排除，不默默带入求和
  const exclusions: { id: number; reason: string }[] = [];
  const valid: EvictionCandidate[] = [];
  for (const c of candidates) {
    if (!Number.isFinite(c.lossValue) || c.lossValue < 0 || !Number.isFinite(c.reclaimableBytes)) {
      exclusions.push({ id: c.id, reason: "invalid_value" });
    } else if (c.reclaimableBytes <= 0) {
      exclusions.push({ id: c.id, reason: "zero_reclaim" });
    } else {
      valid.push(c);
    }
  }

  if (valid.length === 0) {
    return { ...base, status: "no_safe_candidates", exclusions, reason: "无可安全删除的候选" };
  }

  // 保护期候选默认避开；覆盖不了缺口时降级动用（有界保护，不能无限阻塞）
  let pool = valid.filter((c) => !c.protectedByAge);
  let usedProtected = false;
  if (totalReclaim(pool) < needBytes) {
    pool = valid;
    usedProtected = true;
  }
  if (totalReclaim(pool) < needBytes) {
    return {
      ...base,
      status: "insufficient_reclaim",
      usedProtected,
      exclusions,
      reason: `候选合计可释放 ${totalReclaim(pool)} < 缺口 ${needBytes}`,
    };
  }

  // 生成 → 去冗余 → 单项替换 → 统一比较
  const plans = generatePlans(pool, needBytes).map((p) => {
    const pruned = pruneRedundant(p.items, needBytes);
    const improved = singleSwapImprove(pruned, pool, needBytes);
    return { strategy: p.strategy, items: improved };
  });

  const summarize = (items: EvictionCandidate[]) => ({
    loss: totalLoss(items),
    reclaim: totalReclaim(items),
    overshoot: totalReclaim(items) - needBytes,
    idsKey: items
      .map((i) => i.id)
      .sort((a, b) => a - b)
      .join(","),
  });

  plans.sort((a, b) => {
    const sa = summarize(a.items);
    const sb = summarize(b.items);
    const lossScale = Math.max(sa.loss, sb.loss, 1);
    if (Math.abs(sa.loss - sb.loss) > LOSS_TOLERANCE * lossScale) return sa.loss - sb.loss;
    if (sa.overshoot !== sb.overshoot) return sa.overshoot - sb.overshoot;
    if (a.items.length !== b.items.length) return a.items.length - b.items.length;
    return sa.idsKey < sb.idsKey ? -1 : sa.idsKey > sb.idsKey ? 1 : 0;
  });

  const winner = plans[0]!;
  const s = summarize(winner.items);
  // 执行顺序：损失密度升序（最便宜的空间先删；实测恢复即停止,后面的项不再执行）
  const ordered = [...winner.items].sort((a, b) => density(a) - density(b) || byIdAsc(a, b));

  return {
    ...base,
    status: "feasible",
    chosen: ordered.map((c, i) => ({ ...c, evictionRank: i + 1 })),
    expectedTotalLoss: s.loss,
    expectedTotalReclaim: s.reclaim,
    expectedOvershoot: s.overshoot,
    strategy: winner.strategy,
    alternativesSummary: plans.map((p) => {
      const ps = summarize(p.items);
      return {
        strategy: p.strategy,
        totalLoss: ps.loss,
        totalReclaim: ps.reclaim,
        count: p.items.length,
      };
    }),
    usedProtected,
    exclusions,
  };
}
