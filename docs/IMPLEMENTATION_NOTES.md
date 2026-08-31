# 实施说明：排序、空间清理与下载生命周期改造

> 对应设计文稿：`handoff-sorting-optimization-v2.md`（用户提供的优化计划）。
> 实施范围：Phase 0（核验）+ Phase 1（业务语义与磁盘控制）+ Phase 2/3 核心（纯规划器、价值估计、EMA 修复、free 周期重入）。
> 测试：`bun test` 61 pass / 0 fail；`tsc --noEmit` 通过；`vite build` 通过。均为纯函数单测与编译验证，
> **未连接真实 qBittorrent / M-Team / Postgres 做集成验证**（见"上线前置核验项"）。

## 1. Phase 0 核验结论（旧代码 → 现状）

| 计划假设 | 核验结果 |
|---|---|
| 添加前按体积预清理/预留 | 属实：旧 `discover` 计算 `pendingBytes + batchBytes` 预算并调用 `cleanSpace(batchBytes + pendingBytes)`，且按完整体积 skip 候选 |
| 磁盘空间来源 | `qbit /sync/maindata → server_state.free_space_on_disk`，单卷（默认保存路径）；旧代码缺字段时返回 **0**（危险：未知被当成零空间） |
| freeGuard 停止语义 | 旧实现 `stopTorrents` 整体停止，**上传一起停**（与"只停下载"的确认语义不符） |
| seen 永久排除 | 属实：`seen_site_torrents` 命中即永久跳过 |
| EMA | 固定 alpha=0.3 对瞬时 `upspeed` 平滑，`prev===0` 兼作未初始化标记 |
| free 到期删除硬优先 | 属实：`stopped_free_expired` 绝对优先，其余按 score 升序贪心 |

## 2. 修改文件与控制流

### 新增
- `src/server/jobs/diskGuard.ts` — 高频（默认 5s）空间观测 + 压力状态机（HEALTHY/PRESSURE/RECLAIMING/BLOCKED/UNKNOWN）+ 清理执行闭环。触发条件唯一：`实测剩余 < 阈值`；缺口 = `threshold - actualFree`。单 tick 最多删一个，删除前重新观测复核阈值，实测恢复即停、剩余计划作废；删除成功不等于释放（下一 tick 按真实空间重算）。熔断跨 tick：单事件删除上限（默认 20）、连续删除未观测到释放（2 次）→ BLOCKED，仅实测恢复到阈值以上才复位。dry-run 只记录计划（签名去重防事件刷屏），不删除、不模拟释放、不解除压力。
- `src/server/jobs/evictionPlanner.ts` — **纯**规划器 `planEviction(candidates, needBytes, valueUnit)`：4 个启发式（legacy 对照 / 损失密度 / 剩余缺口修正 / 单项覆盖）→ 去冗余 → 有界单项替换 → 统一比较（总损失 → 超额释放 → 数量 → 稳定 ID）。保护期候选默认避开、覆盖不了时降级动用并标记 `usedProtected`。真实清理 / dry-run / UI 共用。
- `src/server/services/value.ts` — 保留价值估计：`expectedUploadBytes = EMA 速率 × 统一窗口`（rate_proxy）；缺速率用批内有效速率中位数先验（global_prior）；整批无速率退回 log1p 需求启发式（fallback_heuristic），**同一计划内单位一致，不混合求和**。free 到期/未完成不归零。
- `src/server/services/ema.ts` — 时间感知 EMA：`alpha = 1 - 2^(-dt/halfLife)`（真半衰期）；null 显式表示未初始化；无效区间（dt≤0、计数回退）由调用方跳过重建基线。拆分/合并区间结果一致（有测试）。
- `src/server/services/freeCycle.ts` — free 周期判定：记录截止未过 = 同周期（延期不建新周期）；已跨过记录截止后再见 free 且截止更晚 = 新周期；记录为不限时 free 保守视为同周期。
- `src/server/services/downloadControl.ts` — 下载阻断控制：原因合并（清一个不清其他）；物理机制首选 filePrio=0（全部文件不下载，已有分片继续上传），失败降级整体 stop 并记 `download_block_degraded` 事件（显式暴露"上传也停了"的缺口，不悄悄退化）。
- 测试：`evictionPlanner.test.ts`（含 §9.4 反例、§15.3 小规模穷举对照、去冗余、保护降级、tie-break）、`value.test.ts`、`ema.test.ts`、`freeCycle.test.ts`、`discover.test.ts` 增补 `rankCandidates`。

### 删除
- `src/server/jobs/spaceClean.ts`（含 `reserveBytes` 语义、free 到期硬优先、贪心按分删除）。

### 修改
- `discover.ts` — 移除空间预检/预算/`cleanSpace` 调用/按完整体积 skip（§3 全部旧规则）；入场排序改为需求启发式分桶降序 + 同档 deadline 升序（不限时不再无条件垫底）；磁盘门控：非 HEALTHY 整轮暂缓新增（`discover_deferred` 事件）；`seen` 改为周期防抖（`markSeen` 记录 freeEndTime，新周期且本地无活跃记录时恢复资格）；被阻断种子再次 free → 恢复下载（复用已有数据）。
- `freeGuard.ts` — `stopTorrents` → `blockDownload(row, "free_expired")`；语义为只阻断下载、保留上传。
- `reconcile.ts` — EMA 改为累计计数差分 + dt 半衰期混合；计数回退/dt≤0 跳过采样只重建基线；收养行不再用瞬时 upspeed 伪造均线（`emaInitialized=false`）；`stopped_free_expired` 状态粘滞（filePrio 会让 qBit 报 progress=1，不能据此判完成），且冻结 sizeBytes/progress（filePrio 改变 qBit 已选体积口径）。
- `qbit/client.ts` — `freeSpaceOnDisk` 返回 `number | null`（缺失 ≠ 0）；新增 `torrentFiles` / `setFilePrio`。
- `config.ts` — 新增 `diskCheckIntervalSec(5)`、`diskObservationMaxAgeSec(20)`、`maxDeletesPerEpisode(20)`、`deleteSettleTimeoutSec(60)`、`predictionHorizonSec(86400)`、`uploadEmaHalfLifeSec(233)`；`spaceCleanIntervalSec` 保留但标记 deprecated（兼容旧 JSON）；旧权重字段保留、注释标 legacy。
- `routes.ts` — `/status` 增加 `pressure`；新增 `GET /plan`（最近计划 + 压力状态）；手动 `start` 走 `clearAllBlocks`（用户显式操作视为接受非 free 计费）。
- `schema.ts` + `drizzle/0002_*.sql` — torrents 增 `ema_initialized / expected_upload_bytes / prediction_kind / predicted_at / download_block`；seen 增 `free_end_time`；新表 `eviction_plans`。迁移含回填：`up_ema>0 → ema_initialized=true`；存量 `stopped_free_expired` → `download_block={reasons:["free_expired"],mechanism:"stopped"}`（如实记录旧机制）。
- 前端 — `Torrents.tsx`：删掉按 score 升序模拟清理顺序；新增清理计划面板（后端实际计划；HEALTHY 显示"当前无需清理"；dry-run 标"演练模式，不会执行"）；评分列改为"预计上传"（窗口内字节，tooltip 带预测类型/legacy 分/预测时间）。`Dashboard.tsx`：磁盘卡片压力徽标。`Settings.tsx`：新字段分组、legacy 权重改名、`spaceClean` 间隔换成 `diskGuard`。

## 3. EMA 半衰期迁移换算

旧行为：alpha=0.3、reconcile 默认 120s → 等价半衰期 `-120·ln2/ln0.7 ≈ 233.2s`，即新默认 `uploadEmaHalfLifeSec=233`。
**若实例的 reconcileIntervalSec 不是 120，应手动按 `-interval·ln2/ln0.7` 换算填入**，以保留原平滑强度；此后再改采样间隔不影响半衰期。

legacy `ageHalfLifeDays` 未改公式（真实半衰期 = 14·ln2 ≈ 9.7 天），仅在 UI 改名为"衰减时间常数（e-folding）"——选择"改名不改行为"路线（§8.6 两个选项之一）；新价值模型不使用该参数。

## 4. 与设计文稿的偏离及理由

1. **压力下未阻断存量下载写入**（§5.2 的 `blockNewDownloadGrowth` 只实现为"暂缓 discover 新增/恢复"）。理由：对全部下载中种子做 filePrio 翻转的震荡与风险（压力事件可能频繁进出）大于收益；存量下载继续、由删除恢复空间。后续可加 `disk_pressure` 阻断原因批量应用。
2. **再次 free 的发现依赖 discover 的 searchFree 召回**（§10.3 要求独立复查）。头部召回可能永远看不到旧种的新 free 周期——已知召回偏差，未实现独立 getDetail 轮询（站点限速考虑）。后续可对 `stopped_free_expired` 行加低频（如每日）getDetail 复查。
3. **计划持久化按签名去重**而非每 tick 落库（避免 5s 级写放大），签名含 status/选中集合/按 GB 取整的缺口。
4. **单卷假设**：qBittorrent 只报默认保存路径卷，`volumeKey="qbit-default"` 常量；多卷/多实例部署不在一期。
5. **单进程单执行器**：并发安全靠 scheduler 的 job 互斥（同进程）；未实现跨进程 Postgres 租约锁（§14.1），多副本部署会破坏单卷单清理器不变量——部署上必须单副本。
6. **非 feasible 计划不做部分删除**（遵循 §5.3 伪代码：直接 BLOCKED）。这与旧行为（能删多少删多少）不同，是设计文稿的明确选择。
7. `torrents.score` 仍在规划时批量更新（legacy 展示 + 对照方案输入），API 未加 legacy 标记字段，前端已把它降级为 tooltip。

## 5. 上线前置核验项（未完成，不能声称已验证）

- **filePrio 语义集成验证**（§6.4 硬性前置）：需在真实 qBittorrent（≥5.2，API key 认证）上验证：全部文件置 0 后 ① 不再下载新载荷 ② 已有分片仍上传 ③ `torrents/info` 的 `size/progress` 口径变化与 reconcile 冻结逻辑相符 ④ 恢复置 1 + start 后正常续下。失败路径（无元数据）已降级为整体 stop 并有事件，但降级率需观察。
- **恢复文件优先级会覆盖用户手动反选**（收养种子若用户只下了部分文件，恢复时会全选）。一期已知限制。
- 站点计费边界（§14.4）：本地 stop/filePrio 响应成功 ≠ 站点侧零计费保证，需观察 M-Team 实际计量。
- dry-run 真实环境走查：压力事件 → 计划事件 → 恢复事件的完整序列。
- 迁移在真实数据库上的执行（`bun run start` 自动跑 drizzle 迁移）。

## 6. 回退说明

- 模型层：规划器保留 `legacy_score_asc` 对照策略；把其余策略视为不可用即回到近似旧排序（但不会恢复 free 到期硬优先/预留——按设计文稿回退原则，这些业务语义不回退）。
- 执行层：`cleanEnabled=false` 停止一切删除（压力状态与新增暂缓仍生效）；`cleanDryRun=true` 全程演练。
- 熔断 BLOCKED 的解除条件：实测空间恢复到阈值以上（含手动删种腾出空间）。
