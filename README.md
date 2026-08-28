# pt-watcher

自动连接 PT 站与 qBittorrent 的前后端一体服务：发现 free 种子自动下载、free 到期自动停止、按流行度自动清理磁盘空间。

## 功能

- **多 PT 平台抽象**：初版实现 M-Team openapi（`x-api-key`），覆盖三套 free 机制（`discount` / `mallSingleFree` / 促销），adapter 接口便于扩展其它站点
- **自动发现与下载**：定时搜索 free 种子，可限定站点分类（UI 在线勾选，mode 自动推导）、只收限时 free（排除长期 free 巨型合集）、按剩余 free 时长与体积过滤，下载 .torrent 解析 infohash 后添加到 qBittorrent（指定分类 + tag），永久去重
- **free 到期守卫**：free 到期前（可配置提前量）复核站点状态，未延期则停止下载，避免产生下载流量
- **空间自动清理**：磁盘剩余空间低于阈值（或不足以容纳 incoming 种子）时，按流行度综合评分从低到高删除；free 到期被停的未完成种子优先清理；支持 dry-run
- **基于分类的管辖**：受管分类内的**全部**种子（含手动添加的，自动「收养」）参与流行度排序与清理；把种子移出受管分类即**永久脱管**，不再被自动停止/删除（UI 可手动重新纳管）
- **Web UI**：概览（磁盘空间/任务状态）、种子列表（来源/状态/评分/free 剩余 + 手动操作）、事件日志、全部行为配置在线编辑

## 流行度评分

`score = w_up·norm(上传速度EMA) + w_demand·norm(leechers/(seeders+1)) + w_ratio·norm(分享率) + w_age·exp(-年龄/半衰期) + w_pop·norm(qBit popularity)`

权重与半衰期均可在 UI 设置中调整；分数低者先被清理；新添加种子有保护期。

## 部署

### 环境变量（secrets，对应 k8s Secret）

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | Postgres 连接串，如 `postgres://user:pass@host:5432/ptwatcher` |
| `MT_API_KEY` | M-Team API key（控制台 → 实验室 → 存取令牌） |
| `MT_BASE_URL` | 可选，默认 `https://api.m-team.cc/api` |
| `QBIT_URL` | qBittorrent WebUI 地址，如 `http://qbittorrent:8080` |
| `QBIT_API_KEY` | qBittorrent WebUI API key（需 qBittorrent ≥ 5.2，在 WebUI 设置中生成，形如 `qbt_...`） |
| `PORT` | 可选，默认 3000 |

行为配置（阈值、间隔、受管分类、评分权重等）存 Postgres `settings` 表，通过 Web UI 修改，启动时自动写入默认值。

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

## 安全模型

- 只有受管分类内的种子会被自动操作；移出分类 = 永久脱管
- 清理删除的种子记入 `seen_site_torrents`，不会被重复下载
- freeGuard 在站点查询失败时保守停止（宁可少下不产生下载流量）
