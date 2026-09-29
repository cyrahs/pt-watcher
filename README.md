# pt-watcher

自动连接 PT 站与 qBittorrent 的前后端一体服务：发现 free 种子自动下载、free 到期自动停止、按流行度自动清理磁盘空间。

## 功能

- **多 PT 平台抽象**：初版实现 M-Team openapi（`x-api-key`），覆盖三套 free 机制（`discount` / `mallSingleFree` / 促销），adapter 接口便于扩展其它站点
- **自动发现与下载**：定时搜索 free 种子，可限定站点分类（UI 在线勾选，mode 自动推导）、只收限时 free（排除长期 free 巨型合集）、按剩余 free 时长与体积过滤，下载 .torrent 解析 infohash 后添加到 qBittorrent（指定分类 + tag），永久去重
- **free 到期守卫**：free 到期前（可配置提前量）复核站点状态，未延期则只阻断下载、已有数据继续上传；阻断后仍无任何数据的种子在 free 截止 N 小时后自动删除
- **空间自动清理**：磁盘剩余空间低于阈值时才触发（零预留），按预测窗口内的预计上传损失最小选择删除集合；支持 dry-run
- **基于分类的管辖**：受管分类内的**全部**种子（含手动添加的，自动「收养」）参与流行度排序与清理；托管与分类强绑定：把种子移出受管分类即**脱管**，不再被自动停止/删除；移回受管分类自动重新纳管
- **Web UI**：概览（磁盘空间/任务状态）、种子列表（来源/状态/评分/free 剩余 + 手动操作）、事件日志、全部行为配置在线编辑
- **HTTP API**：UI 的全部能力 + 过滤/翻页/历史查询 + 种子与系统时间序列 + 发现候选日志，`GET /api` 返回自描述索引；可经 Cloudflare Access service token 供脚本与 agent 访问（见下文）
- **MCP server**：`/mcp` 把 API 按用途封装成 MCP 工具，供 agent 经 LiteLLM MCP 网关使用（见下文）

## 流行度评分

`score = w_up·norm(上传速度EMA) + w_demand·norm(leechers/(seeders+1)) + w_ratio·norm(分享率) + w_age·exp(-年龄/半衰期) + w_pop·norm(qBit popularity)`

权重与半衰期均可在 UI 设置中调整；分数低者先被清理；新添加种子有保护期。

## 部署

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | Postgres 连接串，如 `postgres://user:pass@host:5432/ptwatcher` |
| `PORT` | 可选，默认 3000 |

其余配置全部存 Postgres `settings` 表，通过 Web UI「设置」页修改：

- **连接配置**：M-Team API key（控制台 → 实验室 → 存取令牌）与 API 地址、qBittorrent WebUI 地址与 API key（需 qBittorrent ≥ 5.2，在 WebUI 设置中生成，形如 `qbt_...`），保存后立即生效无需重启
- **行为配置**：阈值、间隔、受管分类、评分权重等

兼容迁移：settings 表中尚无对应值时，`MT_API_KEY` / `MT_BASE_URL` / `QBIT_URL` / `QBIT_API_KEY` 环境变量会作为初始默认值被读入（首次保存后即以 UI 中的值为准）。

### K8s 要点

- 镜像：`ghcr.io/<owner>/pt-watcher`（CI 自动构建 amd64/arm64）
- **`replicas` 必须为 1**：内置调度器无 leader election，多副本会重复添加/删除
- 启动时自动执行数据库 migration
- 默认 `cleanDryRun: true`（清理只记录不真删），确认 dry-run 事件符合预期后在设置中关闭

### 本地开发

```bash
docker compose up -d postgres   # 起 dev 数据库
bun install
bun run dev        # 后端 :3000
bun run dev:web    # 前端 :5173（proxy /api → :3000）
```

测试与构建：

```bash
bun test
bun run typecheck
bun run build      # 前端产物到 dist/web，由后端静态托管
```

图标从 `src/web/public/favicon.svg` 生成（产物已提交）：`bun run gen:icons`

## API

`GET /api` 返回全部接口、参数与约定（单位、时间格式、翻页），与实际路由由测试保证一致。常用：

| 接口 | 用途 |
| --- | --- |
| `GET /api/status` | 运行状态、磁盘与空间压力、各 job 状态 |
| `GET /api/torrents?state=&q=&sort=&order=&limit=&offset=` | 种子列表（含终态记录） |
| `GET /api/torrents/:ref` | 单个种子 + 相关事件（ref = id 或 infohash） |
| `GET /api/snapshots/torrents?torrentId=&since=&until=&cursor=` | 受管种子时间序列：累计上传/下载、EMA、swarm、当时的预测 |
| `GET /api/snapshots/system?since=&until=&cursor=` | 系统时间序列：剩余空间、受管占用、速度、压力状态、各状态种子数、站点账号数据、部署版本 |
| `GET /api/discover/candidates?decision=&added=&since=&cursor=` | 发现候选日志：每个站点种子每个 free 周期一行，含入场时特征与决策（含被过滤/排名靠后/暂缓的） |
| `GET /api/events?type=&torrentRef=&since=&until=&cursor=` | 事件日志（关键事件带结构化 payload） |
| `GET /api/events/stats?since=&bucket=hour\|day` | 事件按类型计数 |
| `GET /api/plans?status=&dryRun=&since=&cursor=` | 清理计划历史（含完整候选） |
| `GET /api/stats/traffic?days=` | 受管种子流量 |

时间参数接受 ISO 8601 或相对时长（`30m` / `24h` / `7d`）；按 id 排序的列表用 `cursor`（上一页最后一条的 id）翻页。

为了能把运行数据的变化归因到具体改动：
- 快照默认每小时一次、保留 90 天（设置页可调）
- 配置修改记入 `settings_updated` 事件（前后值，凭据脱敏）
- 镜像构建时由 CI 注入 `GIT_SHA`，出现在 `/api/status`、`app_started` 事件与系统快照中
- 任务失败/恢复记为 `job_failed` / `job_recovered` 事件（只在状态变化时记录）

### MCP

`POST /mcp` 是同一套能力的 MCP server（streamable HTTP，无状态，JSON 响应）：18 个工具按用途封装上表接口，在进程内调用 `/api` 路由，参数校验、分页与错误语义与 REST 一致（测试保证每个工具指向实际路由）。

- 只读：`get_status`、`get_latest_plan`、`list_torrents`、`get_torrent`、`get_torrent_snapshots`、`get_system_snapshots`、`list_events`、`get_event_stats`、`list_plans`、`get_plan`、`list_discover_candidates`、`get_traffic_stats`、`get_site_stats`、`list_site_categories`、`get_settings`
- 写：`update_settings`（部分更新；不能改凭据字段）、`torrent_action`（stop / start / delete，标记为 destructive）、`run_job`
- 凭据字段（`mtApiKey` / `qbitApiKey`）在返回里脱敏
- 列表类工具默认 limit 比 REST 小（种子 50、时间序列 200、事件 / 候选 100、清理计划 3），避免一次塞满 agent 上下文；需要更多时显式传 limit 或按 cursor 翻页

集群内由 LiteLLM MCP 网关经 Service 地址（`http://pt-watcher.<namespace>.svc.cluster.local/mcp`）接入，agent 用 LiteLLM key 访问网关；经公网域名访问 `/mcp` 与 `/api` 一样受 Cloudflare Access 保护。

### 经 Cloudflare Access 给脚本 / agent 访问

应用本身不做鉴权，公网访问完全依赖 Cloudflare Access。给非浏览器客户端开通：

1. Zero Trust → Access → Service credentials → **Service Tokens** 新建 token，记下 Client ID / Client Secret
2. 在 pt-watcher 现有的 Access 应用里**新增一条策略**：Action 选 **Service Auth**（不是 Allow，service token 只匹配 Service Auth 策略），Include 选 Service Token → 上一步的 token。原来给自己登录用的 Allow 策略保持不变
3. 给客户端提供 token，二选一：
   - **Claude Code 云环境**：在环境里把实例域名配成由出站代理注入该 token 的凭据，并设置环境变量 `PTW_URL`（实例根地址）。请求本身不带 token，脚本也不需要 `op`
   - **1Password**：存进 vault `Agent`、条目 `cloudflare access - claude code`，字段 `client_id`、`client_secret`（按标签匹配），再加一个 URL 类型字段填实例根地址（如 `https://ptw.example.com`）；客户端环境提供 1Password service account（`OP_SERVICE_ACCOUNT_TOKEN`，对该 vault 只读即可）
4. 若环境限制出站域名，把实例域名加入白名单

之后用 `scripts/ptw-api.sh` 调用：设置了 `PTW_URL` 时先直接请求（走代理注入），被 Access 拦截且有 `op` 时回退到 1Password；没有 `PTW_URL` 时直接用 1Password（token 不落盘、不进命令行参数）：

```bash
scripts/ptw-api.sh /api
scripts/ptw-api.sh '/api/events?since=24h&type=clean_blocked'
scripts/ptw-api.sh PUT /api/settings '{"cleanDryRun":false}'
```

vault / 条目可用 `PTW_OP_VAULT` / `PTW_OP_ITEM` 覆盖；本地开发 `PTW_URL=http://localhost:3000 PTW_NO_ACCESS=1`。两种凭据都拿不到、被 Access 拦截（重定向到登录页）时脚本以退出码 3 报错。Claude Code 的使用说明在 `.claude/skills/pt-watcher-ops/SKILL.md`。

## 安全模型

- 只有受管分类内的种子会被自动操作；移出分类 = 脱管，移回分类 = 重新纳管
- 清理删除的种子记入 `seen_site_torrents`，不会被重复下载
- freeGuard 在站点查询失败时保守停止（宁可少下不产生下载流量）
