# Handoff：pt-watcher 排序/评分算法现状与优化任务

> 交接对象：负责优化排序算法的 research agent。本文档自包含，读完即可开工,无需本会话上下文。
> 代码基线：branch `claude/sorting-algorithms-handoff-7b4580`（main 之后无相关改动）。

## 1. 项目背景（一段话）

pt-watcher 是一个 PT 站自动化工具：定时从 M-Team 抓取 free 种子（`discover`），加入 qBittorrent 刷上传量；磁盘空间不足时按"流行度评分"删掉最不值得保留的种子（`spaceClean`）；free 到期前自动停种防扣量（`freeGuard`）；`reconcile` 定期把 qBittorrent 实况同步回 Postgres。技术栈：Bun + TypeScript + Drizzle(Postgres) + React。设置全部存 settings 表、UI 可改，schema 在 `src/server/config.ts`。

**排序算法服务的最终目标只有一个：单位磁盘空间的长期上传量最大化**（free 种子下载不计流量，收益全在上传）。

## 2. 核心算法一：流行度评分 `scoreBatch`

文件：`src/server/services/popularity.ts`（含测试 `popularity.test.ts`）

```
score = wUp·norm(upEma) + wDemand·norm(leechers/(seeders+1))
      + wRatio·norm(min(ratio,10)) + wAge·exp(-ageDays/ageHalfLifeDays)
      + wPop·norm(qbitPopularity)
```

- `norm` = **批内 min-max 归一化**；批内全相等或非有限值时统一返回 0.5。
- 默认权重（settings 可改）：upload 0.4 / demand 0.3 / ratio 0.1 / age 0.1 / qbitPopularity 0.1；`ageHalfLifeDays` 默认 14。
- 输入特征来源：`upEma` 是 reconcile 维护的上传速度指数均线；`seeders/leechers` 来自站点 API；`ratio/qbitPopularity` 来自 qBittorrent（popularity 是 qbit 5.x 的字段）。
- 分数越高越值得保留。**分数只在同一批候选内可比，不跨批可比**（代码注释已声明），但会被持久化到 `torrents.score` 供 UI 展示——这本身是个语义矛盾点。

### 已知问题（优化切入点）

1. **归一化让权重语义不稳定**：min-max 依赖批内极值，一个离群点会压扁其它所有样本的该维度差异；权重实际效果随批次数据分布漂移。可考虑固定尺度归一化、rank/分位数归一化或 z-score。
2. **age 项与其它项尺度不一致**：其它四项是批内相对值(0~1)，age 是绝对衰减值(0~1)，同一权重下含义不同。
3. **"half-life" 命名不准确**：`exp(-age/halfLife)` 在 age=halfLife 时是 e⁻¹≈0.37 而不是 0.5；真正的半衰期应为 `exp(-ln2·age/halfLife)`。是改公式还是改名，需要定夺（改公式会轻微改变现有行为）。
4. **demand = leechers/(seeders+1) 重尾**：热门新种可能出现几百的值，min-max 后其余全被压到接近 0；可考虑 log 压缩。
5. **ratio 项方向存疑**：ratio 高=已经赚够了，作为"值得保留"的正向分是否合理？也可能高 ratio 恰恰说明这种子持续产出。值得用数据验证。
6. **评分完全没考虑体积**：一个 200GB 低分种子和一个 1GB 低分种子在删除排序里同权,但释放价值差 200 倍（见下节）。
7. **评分没有 progress 特征**：见 §5.5 横切缺口。

## 3. 核心算法二：空间清理删除顺序 `cleanSpace`

文件：`src/server/jobs/spaceClean.ts`

流程：算出缺口 `needBytes = threshold + reserveBytes - freeSpace` → 候选 = 受管分类内、过了保护期（默认 6h）的活跃种子 → `scoreBatch` 评分并逐行写回 DB → 排序 → 贪心逐个删除直到缺口补齐。

排序规则（`spaceClean.ts:67`）：

1. `stopped_free_expired`（free 到期被停的未完成种子，纯死重）绝对优先；
2. 其余按 score **升序**（最不值得保留的先删）。

### 已知问题

1. **贪心不考虑体积**：这本质是覆盖缺口的选择问题，按 score 升序贪心可能删 10 个高分小种子却放过 1 个低分大种子。合理目标是"损失的保留价值最小化"，接近 knapsack/按 `score/GB` 密度排序的问题。缺口通常远小于总量,精确解不必要,但密度启发式几乎白赚。
2. **未完成种子按进度折算占用**（`onDiskBytes`），但删除释放量按此估算与实际可能有偏差（qbit 分配策略）。
3. 评分写回是逐行 `UPDATE` 循环，候选多时 N 次查询（性能小问题,顺手可修）。
4. `stopped_free_expired` 优先级是硬编码的两级,若未来出现别的"死重"状态需要扩展。

## 4. 核心算法三：discover 候选排序

文件：`src/server/jobs/discover.ts:75-81`

- 过滤（free 剩余时长 ≥ minFreeHours、体积在 min/maxSizeGB 内、未见过）后,按 **free 截止时间升序**（急的先下），`freeEndTime=null`（不限时）排最后 → 取前 `maxAddPerRun`（默认 10）。
- 代码注释里留了原始权衡："大者优先能更充分利用 free，但也更容易占满"。
- 空间预算逐个检查,放不下就 skip（不 break），后面的小种子仍有机会。

### 已知问题

1. **只按 deadline 排序,完全没有价值判断**：新种的 seeders/leechers 数据是现成的（`FreeTorrent` 上就有），却没用来预测上传潜力。deadline 紧但没人要的种子会挤掉 deadline 稍松但需求旺盛的。这里可以复用/派生 popularity 的 demand 思路,做一个"入场评分"。
2. deadline 升序还有个副作用：剩余 free 时间最短的（比如刚过 minFreeHours 线的）最优先,但这类种子恰恰最可能下不完就到期变死重。deadline 与完成概率（体积/带宽）应联合考虑。
3. 站点侧召回也有排序参与（`src/server/pt/mteam.ts:244-269`）：FREE 过滤搜索按 `CREATED_DATE DESC` + 默认排序头部各取一页（pageSize 有限），召回天然偏新种。优化候选排序时注意上游召回偏差。

## 5. 核心算法四：上传速度 EMA `updateEma`

文件：`src/server/services/popularity.ts:47-49`，调用点 `src/server/jobs/reconcile.ts:83`

- `ema = 0.3·current + 0.7·prev`，`prev===0` 时直接取 current（冷启动）。
- reconcile 默认每 120s 跑一次,但间隔是 settings 可改的——**alpha 固定意味着平滑时间常数随 reconcile 间隔漂移**。规范做法是按 Δt 计算 `alpha = 1 - exp(-Δt/τ)`。
- `prev===0` 的冷启动分支有个边角：真实上传速度归零一段时间后 EMA 衰减到 0,下一个非零采样会被当成冷启动直接跳变（浮点上 EMA 很难精确到 0,实际影响小,但语义上是错的）。

## 5.5 横切缺口：下载进度在全链路缺位

freeGuard（`src/server/jobs/freeGuard.ts`）会在 free 到期前 `freeStopLeadMinutes`（默认 15min）复核站点、确认未延期后停掉未完成的下载,由此产生 `stopped_free_expired` 死重。但**进度/ETA 目前在所有决策点都不参与**（freeGuard 只用 `progress >= 1` 跳过已完成的,99% 与 5% 待遇相同）：

1. **入场（discover）**：不结合体积与历史带宽预测"到期前能否下完",只要剩余 free ≥ minFreeHours 就收。下不完的种子从入场起就注定变死重。
2. **下载中（freeGuard）**：不看 ETA。明显下不完的种子会一直下到最后 15 分钟才停,期间下载的字节到期后全部白占空间（free 期内下载不扣量,但空间被浪费）；反之,剩余极少且带宽足够的种子也被一刀切提前停掉。可考虑"预计完不成即早停止损"与"接近完成则精确计算是否放行"。
3. **删除（spaceClean）**：`stopped_free_expired` 整体绝对优先删除,不按进度区分残值。99% 进度的停种再补 1% 付费下载量即可转为可做种资产,现状却与 1% 进度的同等待遇、最先被删。"补完 vs 删除"是可量化的决策（补完成本 = 剩余字节的下载扣量 vs 预期上传收益）。

评分特征里也没有 progress。这条主线建议作为整体来设计,而不是三处各自打补丁。

## 6. 纯展示排序（低优先级,列出仅供全景）

| 位置 | 规则 |
|---|---|
| `src/server/api/routes.ts:53-54` | 种子列表 `addedAt DESC` |
| `src/server/api/routes.ts:100` | 流量日聚合按 `day` 升序 |
| `src/server/api/routes.ts:142` | 事件按 `ts DESC` |
| `src/web/pages/Torrents.tsx:47-54` | "跟踪中"筛选下前端按 score **升序**（最先被清理的排最前,给用户预览删除顺序）；其它筛选保持 API 顺序 |

注意：前端把 score 升序作为"删除预览"，但实际删除顺序还有 `stopped_free_expired` 优先规则,两者不完全一致；且 score 是上次 spaceClean 跑时的快照。若改评分算法,记得同步这里的展示语义。

## 7. 约束与验收

- **settings 兼容**：权重字段已存在于用户数据库（`settingsSchema`，key=`app` 的 JSON）,新增字段要给默认值,改语义要考虑老配置的行为突变;Settings 页 UI（`src/web/pages/Settings.tsx`）有对应表单。
- **score 展示契约**：UI 按"0~1 左右、越高越保留"展示（保留 3 位小数）,大改评分尺度需同步前端。
- **测试**：`src/server/services/popularity.test.ts` 已覆盖单调性（热门>冷门、需求>饱和、新>旧）与空批/单元素边角,跑法 `bun test`。改算法必须保住这些性质或有意识地推翻并改测试。
- **dry-run 通路**：`cleanDryRun` 默认 true,删除排序的任何改动都能先用 dry-run 事件日志验证,请利用它设计验证方案。
- 代码与注释语言为中文,保持一致。

## 8. 建议的优化优先级（仅供参考,可推翻）

1. spaceClean 引入体积感知（score/GB 密度或近似 knapsack）——收益最直接。
2. 进度/ETA 主线（§5.5）：入场完成概率 → 下载中早停止损 → 高进度停种"补完 vs 删除"。
3. discover 入场评分（demand + 完成概率,与上一条合并设计）。
4. scoreBatch 归一化方案重做（rank/固定尺度）,顺手修 age 尺度与 half-life 语义。
5. EMA 按 Δt 参数化 alpha。
