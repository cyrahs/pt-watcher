// GET /api 返回的接口索引：人和 agent 都从这里发现能力。
// docs.test.ts 校验它与实际注册的路由一一对应，新增/删除路由必须同步这里。

export interface EndpointDoc {
  method: "GET" | "POST" | "PUT";
  /** 相对 /api 的路径（与路由注册一致） */
  path: string;
  summary: string;
  params?: Record<string, string>;
}

export const apiConventions = {
  auth: "经 Cloudflare Access：浏览器登录，或 service token（请求头 CF-Access-Client-Id / CF-Access-Client-Secret）",
  units: "字节数字段以 Bytes 结尾；速率 upEma、*BytesPerSec 为 B/s；*Sec 为秒；时间为 ISO 8601（UTC）",
  time: "since / until 接受 ISO 8601（如 2026-09-01T00:00:00Z，时区偏移里的 + 需编码为 %2B）或相对时长 30m / 24h / 7d（= 当前时间往前推）；区间左闭右开",
  pagination: "按 id 排序的列表用 cursor 翻页：传上一页最后一条的 id；返回条数 < limit 即到底",
  errors: "非 2xx 返回 { error }；参数非法返回 400",
};

const TIME_RANGE = {
  since: "起始时间（含）",
  until: "截止时间（不含）",
};

const PAGED = {
  limit: "每页条数",
  cursor: "上一页最后一条的 id",
  order: "asc / desc（按 id）",
};

export const endpointDocs: EndpointDoc[] = [
  { method: "GET", path: "/", summary: "本索引：约定与全部接口" },

  // 现状
  {
    method: "GET",
    path: "/status",
    summary: "运行状态：qBittorrent 连接与实时速度、磁盘剩余与阈值、空间压力状态机、各 job 最近运行情况",
  },
  { method: "GET", path: "/plan", summary: "最近一次清理计划 + 当前空间压力状态" },
  { method: "GET", path: "/stats/site", summary: "各站点账号数据（上传/下载量、分享率、魔力值），实时请求站点" },
  { method: "GET", path: "/pt/categories", summary: "各站点分类列表（实时请求站点）" },

  // 种子
  {
    method: "GET",
    path: "/torrents",
    summary: "种子列表（含终态记录）。不带 limit 时返回全部",
    params: {
      state: "状态过滤，逗号分隔：downloading / completed / stopped_free_expired / deleted_by_cleanup / removed_external / untracked",
      q: "名称包含（不区分大小写）",
      sort: "addedAt（默认）/ id / name / sizeBytes / upEma / expectedUploadBytes / totalUploadedBytes / ratio / seeders / leechers / freeEndTime",
      order: "asc / desc（默认 desc，null 排最后）",
      limit: "条数上限（最大 5000）",
      offset: "偏移",
    },
  },
  {
    method: "GET",
    path: "/torrents/:ref",
    summary: "单个种子详情 + 最近 50 条相关事件；ref 为数字 id 或 infohash",
  },
  {
    method: "POST",
    path: "/torrents/:id/:action",
    summary: "种子操作：stop / start（清除全部下载阻断并恢复，可能产生非 free 下载计费）/ delete（连同数据删除）",
  },
  {
    method: "GET",
    path: "/snapshots",
    summary: "受管种子的时间序列快照（按 snapshotIntervalSec 采样），用于评估预测与趋势分析",
    params: {
      torrentId: "种子 id 过滤，逗号分隔",
      ...TIME_RANGE,
      ...PAGED,
      limit: "每页条数（默认 1000，最大 10000）",
      order: "asc（默认）/ desc（按 id）",
    },
  },

  // 决策与事件
  {
    method: "GET",
    path: "/plans",
    summary: "清理计划历史（真实与演练；按签名去重落库）",
    params: {
      status: "计划状态过滤，逗号分隔",
      dryRun: "true / false",
      ...TIME_RANGE,
      ...PAGED,
      limit: "每页条数（默认 50，最大 1000）",
      order: "asc / desc（默认 desc，按 id）",
    },
  },
  { method: "GET", path: "/plans/:id", summary: "单个清理计划" },
  {
    method: "GET",
    path: "/events",
    summary: "事件日志",
    params: {
      type: "事件类型过滤，逗号分隔",
      torrentRef: "种子 infohash",
      ...TIME_RANGE,
      ...PAGED,
      limit: "每页条数（默认 100，最大 5000）",
      order: "asc / desc（默认 desc，按 id）",
      offset: "偏移（兼容旧用法，翻页优先用 cursor）",
    },
  },
  {
    method: "GET",
    path: "/events/stats",
    summary: "事件按类型计数，可按小时/天分桶（桶按服务器时区对齐）",
    params: {
      since: "起始时间（含，默认 24h）",
      until: "截止时间（不含，默认当前）",
      bucket: "none（默认）/ hour / day",
      type: "事件类型过滤，逗号分隔",
    },
  },
  {
    method: "GET",
    path: "/stats/traffic",
    summary: "受管种子流量：累计总量 + 按日明细",
    params: { days: "最近天数（默认 30，1–365）" },
  },

  // 配置与控制
  { method: "GET", path: "/settings", summary: "全部行为配置（含站点与 qBittorrent 的 API key）" },
  {
    method: "PUT",
    path: "/settings",
    summary: "修改配置：请求体为要修改的字段（部分更新），保存后立即生效",
  },
  {
    method: "POST",
    path: "/jobs/:name/run",
    summary: "立即触发一次任务：reconcile / freeGuard / discover / diskGuard",
  },
  { method: "POST", path: "/test/mteam", summary: "测试 M-Team 连接（请求体可带未保存的 mtApiKey / mtBaseUrl）" },
  { method: "POST", path: "/test/qbit", summary: "测试 qBittorrent 连接（请求体可带未保存的 qbitUrl / qbitApiKey）" },
];
