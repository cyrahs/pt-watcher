// MCP server（streamable HTTP，挂在 /mcp）：把 /api 的能力按用途封装成工具，供 agent 经 LiteLLM MCP 网关使用。
// 工具在进程内调用 /api 路由（api.request），参数校验、分页与错误语义与 REST 完全一致；
// tools.test.ts 校验每个工具指向真实注册的路由。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import { apiConventions } from "../api/docs";
import { buildInfo, SECRET_KEYS } from "../config";

/** 能在进程内处理请求的 /api 应用（生产为 api/routes 的 Hono 实例，测试可替换） */
export interface ApiApp {
  request(input: string, init?: RequestInit): Response | Promise<Response>;
}

type Query = Record<string, string | number | boolean | string[] | number[] | undefined>;

interface ApiCall {
  path: string;
  query?: Query;
  body?: unknown;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  method: "GET" | "POST" | "PUT";
  /** 对应的 /api 路由（相对 /api，与路由注册一致） */
  route: string;
  readOnly: boolean;
  destructive?: boolean;
  input?: ZodRawShape;
  /** 由 input 校验过的参数构造 /api 请求（参数类型由 input 决定） */
  call: (args: any) => ApiCall | string;
  /** 调用前的额外检查，返回错误信息则拒绝 */
  reject?: (args: any) => string | undefined;
  transform?: (data: unknown) => unknown;
}

const ORDER = z.enum(["asc", "desc"]);
const TIME = z
  .string()
  .describe("ISO 8601（如 2026-09-01T00:00:00Z）或相对时长 30m / 24h / 7d（= 当前时间往前推）");
const CURSOR = z.number().int().positive().describe("上一页最后一条的 id；返回条数 < limit 即到底");
const TORRENT_STATES = [
  "downloading",
  "completed",
  "stopped_free_expired",
  "deleted_by_cleanup",
  "removed_external",
  "untracked",
] as const;
const TORRENT_SORTS = [
  "addedAt",
  "id",
  "name",
  "sizeBytes",
  "upEma",
  "expectedUploadBytes",
  "totalUploadedBytes",
  "ratio",
  "seeders",
  "leechers",
  "freeEndTime",
] as const;
const JOBS = ["reconcile", "freeGuard", "discover", "diskGuard", "snapshot"] as const;

function limit(def: number, max: number) {
  return z.number().int().positive().max(max).describe(`条数上限（默认 ${def}，最大 ${max}）`);
}

/** 配置里的凭据只标记是否已填写，不经 MCP 返回 */
export function redactSettings(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const out: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  for (const key of SECRET_KEYS) {
    if (typeof out[key] === "string" && out[key]) out[key] = "<redacted>";
  }
  return out;
}

export const tools: ToolDef[] = [
  // 现状
  {
    name: "get_status",
    title: "运行状态",
    description:
      "运行状态：部署版本、qBittorrent 连接与实时速度、磁盘剩余与阈值、受管占用、空间压力状态机、各 job 最近运行情况",
    method: "GET",
    route: "/status",
    readOnly: true,
    call: () => "/status",
  },
  {
    name: "get_latest_plan",
    title: "最近清理计划",
    description: "最近一次清理计划（含完整候选）+ 当前空间压力状态。计划是建议快照，不是删除授权",
    method: "GET",
    route: "/plan",
    readOnly: true,
    call: () => "/plan",
  },
  {
    name: "get_site_stats",
    title: "站点账号数据",
    description: "各站点账号数据（上传/下载量、分享率、魔力值），实时请求站点",
    method: "GET",
    route: "/stats/site",
    readOnly: true,
    call: () => "/stats/site",
  },
  {
    name: "list_site_categories",
    title: "站点分类",
    description: "各站点分类列表（实时请求站点），用于配置 searchCategories",
    method: "GET",
    route: "/pt/categories",
    readOnly: true,
    call: () => "/pt/categories",
  },
  {
    name: "get_traffic_stats",
    title: "流量统计",
    description: "受管种子流量：累计总量 + 按日明细（按服务器时区日切）",
    method: "GET",
    route: "/stats/traffic",
    readOnly: true,
    input: { days: z.number().int().min(1).max(365).optional().describe("最近天数（默认 30）") },
    call: (a) => ({ path: "/stats/traffic", query: { days: a.days } }),
  },

  // 种子
  {
    name: "list_torrents",
    title: "种子列表",
    description: "种子列表（含终态记录），可按状态、名称过滤与排序，limit/offset 翻页",
    method: "GET",
    route: "/torrents",
    readOnly: true,
    input: {
      states: z.array(z.enum(TORRENT_STATES)).optional().describe("状态过滤，不填 = 全部"),
      q: z.string().optional().describe("名称包含（不区分大小写）"),
      sort: z.enum(TORRENT_SORTS).optional().describe("排序字段（默认 addedAt）"),
      order: ORDER.optional().describe("默认 desc，null 排最后"),
      limit: limit(50, 5000).optional(),
      offset: z.number().int().nonnegative().optional(),
    },
    call: (a) => ({
      path: "/torrents",
      query: { state: a.states, q: a.q, sort: a.sort, order: a.order, limit: a.limit ?? 50, offset: a.offset },
    }),
  },
  {
    name: "get_torrent",
    title: "种子详情",
    description: "单个种子详情 + 最近 50 条相关事件",
    method: "GET",
    route: "/torrents/:ref",
    readOnly: true,
    input: { ref: z.string().min(1).describe("数字 id 或 infohash") },
    call: (a) => `/torrents/${encodeURIComponent(a.ref)}`,
  },
  {
    name: "get_torrent_snapshots",
    title: "种子时间序列",
    description:
      "受管种子时间序列快照（每 snapshotIntervalSec 一批）：累计上传/下载、EMA、swarm、当时的预测，用于评估预测与收益曲线。按 id 升序，cursor 翻页",
    method: "GET",
    route: "/snapshots/torrents",
    readOnly: true,
    input: {
      torrentIds: z.array(z.number().int().positive()).optional().describe("种子 id 过滤"),
      since: TIME.optional().describe("起始时间（含）"),
      until: TIME.optional().describe("截止时间（不含）"),
      cursor: CURSOR.optional(),
      order: ORDER.optional().describe("按 id，默认 asc"),
      limit: limit(200, 10000).optional(),
    },
    call: (a) => ({
      path: "/snapshots/torrents",
      query: {
        torrentId: a.torrentIds,
        since: a.since,
        until: a.until,
        cursor: a.cursor,
        order: a.order,
        limit: a.limit ?? 200,
      },
    }),
  },
  {
    name: "get_system_snapshots",
    title: "系统时间序列",
    description:
      "系统时间序列快照：剩余空间、受管占用、全局速度、压力状态、各状态种子数、站点账号数据、部署版本 gitSha。按 id 升序，cursor 翻页",
    method: "GET",
    route: "/snapshots/system",
    readOnly: true,
    input: {
      since: TIME.optional().describe("起始时间（含）"),
      until: TIME.optional().describe("截止时间（不含）"),
      cursor: CURSOR.optional(),
      order: ORDER.optional().describe("按 id，默认 asc"),
      limit: limit(200, 10000).optional(),
    },
    call: (a) => ({
      path: "/snapshots/system",
      query: { since: a.since, until: a.until, cursor: a.cursor, order: a.order, limit: a.limit ?? 200 },
    }),
  },

  // 决策与事件
  {
    name: "list_events",
    title: "事件日志",
    description: "事件日志（关键事件带结构化 payload）。按 id 降序，cursor 翻页；事件类型可先用 get_event_stats 查看",
    method: "GET",
    route: "/events",
    readOnly: true,
    input: {
      types: z.array(z.string()).optional().describe("事件类型过滤"),
      torrentRef: z.string().optional().describe("种子 infohash"),
      since: TIME.optional().describe("起始时间（含）"),
      until: TIME.optional().describe("截止时间（不含）"),
      cursor: CURSOR.optional(),
      order: ORDER.optional().describe("按 id，默认 desc"),
      limit: limit(100, 5000).optional(),
    },
    call: (a) => ({
      path: "/events",
      query: {
        type: a.types,
        torrentRef: a.torrentRef,
        since: a.since,
        until: a.until,
        cursor: a.cursor,
        order: a.order,
        limit: a.limit ?? 100,
      },
    }),
  },
  {
    name: "get_event_stats",
    title: "事件计数",
    description: "事件按类型计数，可按小时/天分桶（桶按服务器时区对齐）",
    method: "GET",
    route: "/events/stats",
    readOnly: true,
    input: {
      since: TIME.optional().describe("起始时间（含，默认 24h）"),
      until: TIME.optional().describe("截止时间（不含，默认当前）"),
      bucket: z.enum(["none", "hour", "day"]).optional().describe("默认 none"),
      types: z.array(z.string()).optional().describe("事件类型过滤"),
    },
    call: (a) => ({
      path: "/events/stats",
      query: { since: a.since, until: a.until, bucket: a.bucket, type: a.types },
    }),
  },
  {
    name: "list_plans",
    title: "清理计划历史",
    description: "清理计划历史（真实与演练，含完整候选，单条可达数十 KB；按签名去重落库）。按 id 降序，cursor 翻页",
    method: "GET",
    route: "/plans",
    readOnly: true,
    input: {
      statuses: z
        .array(z.string())
        .optional()
        .describe("计划状态过滤：feasible / insufficient_reclaim / no_safe_candidates / invalid_input"),
      dryRun: z.boolean().optional(),
      since: TIME.optional().describe("起始时间（含）"),
      until: TIME.optional().describe("截止时间（不含）"),
      cursor: CURSOR.optional(),
      order: ORDER.optional().describe("按 id，默认 desc"),
      limit: limit(3, 1000).optional(),
    },
    call: (a) => ({
      path: "/plans",
      query: {
        status: a.statuses,
        dryRun: a.dryRun,
        since: a.since,
        until: a.until,
        cursor: a.cursor,
        order: a.order,
        limit: a.limit ?? 3,
      },
    }),
  },
  {
    name: "get_plan",
    title: "单个清理计划",
    description: "按 id 取单个清理计划",
    method: "GET",
    route: "/plans/:id",
    readOnly: true,
    input: { id: z.number().int().positive() },
    call: (a) => `/plans/${a.id}`,
  },
  {
    name: "list_discover_candidates",
    title: "发现候选日志",
    description:
      "发现候选日志：站点 free 列表中每个种子每个 free 周期一行，含入场时的站点特征、最近一次看到时的 swarm、最近一次决策与名次；经 infoHash 或站点种子 id 与种子列表关联。按 id 降序，cursor 翻页",
    method: "GET",
    route: "/discover/candidates",
    readOnly: true,
    input: {
      decisions: z
        .array(z.string())
        .optional()
        .describe("决策过滤：added / existing / filtered / seen / ranked_out / deferred / error"),
      siteId: z.string().optional(),
      added: z.boolean().optional().describe("true = 本周期内已添加 / false = 未添加"),
      since: TIME.optional().describe("最近一次看到的时间下限（含）"),
      until: TIME.optional().describe("最近一次看到的时间上限（不含）"),
      cursor: CURSOR.optional(),
      order: ORDER.optional().describe("按 id，默认 desc"),
      limit: limit(100, 5000).optional(),
    },
    call: (a) => ({
      path: "/discover/candidates",
      query: {
        decision: a.decisions,
        siteId: a.siteId,
        added: a.added,
        since: a.since,
        until: a.until,
        cursor: a.cursor,
        order: a.order,
        limit: a.limit ?? 100,
      },
    }),
  },

  // 配置与控制
  {
    name: "get_settings",
    title: "读取配置",
    description: "全部行为配置（阈值、间隔、受管分类、过滤条件、评分参数等）；凭据字段已脱敏",
    method: "GET",
    route: "/settings",
    readOnly: true,
    call: () => "/settings",
    transform: redactSettings,
  },
  {
    name: "update_settings",
    title: "修改配置",
    description:
      "部分更新配置：changes 只放要改的字段（字段名与类型同 get_settings），保存后立即生效，变更记入 settings_updated 事件。凭据字段（mtApiKey / qbitApiKey）不能经 MCP 修改",
    method: "PUT",
    route: "/settings",
    readOnly: false,
    input: { changes: z.record(z.unknown()).describe("要修改的字段，如 {\"cleanDryRun\": false}") },
    reject: (a) => {
      const secret = Object.keys(a.changes).filter((k) => SECRET_KEYS.has(k));
      return secret.length > 0 ? `凭据字段不能经 MCP 修改，请在 Web UI 设置: ${secret.join(", ")}` : undefined;
    },
    call: (a) => ({ path: "/settings", body: a.changes }),
    transform: redactSettings,
  },
  {
    name: "torrent_action",
    title: "种子操作",
    description:
      "stop：停止；start：清除全部下载阻断并恢复（可能产生非 free 下载计费）；delete：从 qBittorrent 连同数据删除（不可撤销）",
    method: "POST",
    route: "/torrents/:id/:action",
    readOnly: false,
    destructive: true,
    input: {
      id: z.number().int().positive().describe("种子 id（不是 infohash）"),
      action: z.enum(["stop", "start", "delete"]),
    },
    call: (a) => `/torrents/${a.id}/${a.action}`,
  },
  {
    name: "run_job",
    title: "立即运行任务",
    description: "立即触发一次后台任务（异步，立即返回）；结果看 get_status 的 jobs 或事件日志",
    method: "POST",
    route: "/jobs/:name/run",
    readOnly: false,
    input: { name: z.enum(JOBS) },
    call: (a) => `/jobs/${a.name}/run`,
  },
];

function buildUrl(call: ApiCall): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(call.query ?? {})) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) params.set(key, value.join(","));
    } else {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `${call.path}?${qs}` : call.path;
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

export async function callTool(app: ApiApp, tool: ToolDef, args: unknown): Promise<CallToolResult> {
  const rejected = tool.reject?.(args);
  if (rejected) return errorResult(rejected);
  const spec = tool.call(args);
  const call = typeof spec === "string" ? { path: spec } : spec;
  const init: RequestInit = { method: tool.method };
  if (call.body !== undefined) {
    init.body = JSON.stringify(call.body);
    init.headers = { "content-type": "application/json" };
  }
  const res = await app.request(buildUrl(call), init);
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = data && typeof data === "object" && "error" in data ? String(data.error) : text;
    return errorResult(`HTTP ${res.status}: ${msg}`);
  }
  const out = tool.transform ? tool.transform(data) : data;
  return { content: [{ type: "text", text: JSON.stringify(out) }] };
}

const instructions = [
  "pt-watcher：自动从 PT 站发现 free 种子下载到 qBittorrent，free 到期停止，磁盘不足时按预计上传损失最小清理。",
  `单位：${apiConventions.units}`,
  "时间参数：ISO 8601 或相对时长 30m / 24h / 7d；区间左闭右开。",
  "翻页：时间序列、事件、计划、候选按 id 排序，传上一页最后一条的 id 作 cursor；返回条数 < limit 即到底。",
  "写操作（update_settings / torrent_action / run_job）会立即改变线上行为，先读后改。",
].join("\n");

export function createMcpServer(app: ApiApp): McpServer {
  const server = new McpServer(
    { name: "pt-watcher", version: buildInfo.gitSha?.slice(0, 7) ?? "dev" },
    { instructions },
  );
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input ?? {},
        annotations: {
          title: tool.title,
          readOnlyHint: tool.readOnly,
          destructiveHint: tool.readOnly ? undefined : Boolean(tool.destructive),
          idempotentHint: tool.readOnly ? undefined : tool.name !== "run_job",
          openWorldHint: false,
        },
      },
      (args: unknown) => callTool(app, tool, args),
    );
  }
  return server;
}

/**
 * 处理一个 /mcp 请求。无状态模式：每个请求新建 server 与 transport，不发 session id，
 * 单副本与重启都无需保持会话；只支持 POST（JSON 响应），GET/DELETE 返回 405。
 */
export async function handleMcpRequest(req: Request, app: ApiApp): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
      { status: 405, headers: { allow: "POST" } },
    );
  }
  const server = createMcpServer(app);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await server.close();
  }
}
