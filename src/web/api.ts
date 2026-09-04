export interface TorrentRow {
  id: number;
  infoHash: string;
  siteId: string | null;
  siteTorrentId: string | null;
  name: string;
  sizeBytes: number;
  category: string;
  state: string;
  addedByWatcher: boolean;
  freeEndTime: string | null;
  upEma: number;
  ratio: number;
  progress: number;
  seeders: number;
  leechers: number;
  /** legacy 批内评分（仅过渡展示，不代表清理顺序） */
  score: number;
  /** 统一预测窗口内的预计上传字节（null = 无可解释预测/尚未评估） */
  expectedUploadBytes: number | null;
  predictionKind: string | null;
  predictedAt: string | null;
  downloadBlock: { reasons: string[]; mechanism: string | null } | null;
  addedAt: string;
}

export interface PressureState {
  state: "HEALTHY" | "PRESSURE" | "RECLAIMING" | "BLOCKED" | "UNKNOWN";
  volumeKey: string;
  freeBytes: number | null;
  observedAt: string | null;
  /** 实测 + 未到账释放 */
  effectiveFreeBytes: number | null;
  /** 已下发删除、尚未在实测中体现的释放 */
  pendingReleaseBytes: number;
  blockedReason: string | null;
  episodeDeletes: number;
}

export interface EvictionPlanItem {
  id: number;
  name: string;
  lossValue: number;
  reclaimableBytes: number;
  evictionRank: number;
}

export interface EvictionPlanRow {
  id: number;
  createdAt: string;
  volumeKey: string;
  triggerReason: string;
  actualFreeBytes: number;
  thresholdBytes: number;
  needBytes: number;
  status: string;
  dryRun: boolean;
  plan: {
    valueUnit: "bytes" | "heuristic";
    strategy: string;
    chosen: EvictionPlanItem[];
    expectedTotalLoss: number;
    expectedTotalReclaim: number;
    expectedOvershoot: number;
    usedProtected: boolean;
    reason: string | null;
  };
}

export interface PlanResponse {
  pressure: PressureState;
  latest: EvictionPlanRow | null;
}

export interface EventRow {
  id: number;
  ts: string;
  type: string;
  torrentRef: string | null;
  message: string;
}

export interface JobStatus {
  name: string;
  lastRunAt: string | null;
  lastFinishedAt: string | null;
  lastError: string | null;
  running: boolean;
}

export interface PtCategory {
  siteId: string;
  id: string;
  name: string;
  group: string;
}

export interface TrafficDay {
  day: string;
  uploadedBytes: number;
  downloadedBytes: number;
}

export interface TrafficStats {
  totals: { uploadedBytes: number; downloadedBytes: number };
  daily: TrafficDay[];
}

export interface SiteUserStats {
  siteId: string;
  username: string | null;
  uploadedBytes: number;
  downloadedBytes: number;
  shareRate: number | null;
  bonus: number | null;
}

export interface Status {
  qbit: {
    configured: boolean;
    connected: boolean;
    url: string;
    /** 全局实时下载速度（B/s），未连接时 null */
    dlSpeedBytesPerSec: number | null;
    /** 全局实时上传速度（B/s），未连接时 null */
    upSpeedBytesPerSec: number | null;
  };
  mteam: { configured: boolean };
  freeSpaceBytes: number | null;
  freeSpaceThresholdBytes: number;
  diskTotalBytes: number | null;
  pressure: PressureState;
  jobs: JobStatus[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  status: () => request<Status>("/status"),
  torrents: () => request<TorrentRow[]>("/torrents"),
  torrentAction: (id: number, action: string) =>
    request<{ ok: boolean }>(`/torrents/${id}/${action}`, { method: "POST" }),
  events: (limit = 100) => request<EventRow[]>(`/events?limit=${limit}`),
  settings: () => request<Record<string, unknown>>("/settings"),
  saveSettings: (patch: Record<string, unknown>) =>
    request<Record<string, unknown>>("/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  runJob: (name: string) => request<{ ok: boolean }>(`/jobs/${name}/run`, { method: "POST" }),
  plan: () => request<PlanResponse>("/plan"),
  trafficStats: (days = 30) => request<TrafficStats>(`/stats/traffic?days=${days}`),
  siteStats: () => request<SiteUserStats[]>("/stats/site"),
  testConnection: (target: "mteam" | "qbit", values: Record<string, unknown>) =>
    request<{ ok: boolean; message: string }>(`/test/${target}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    }),
  ptCategories: () => request<PtCategory[]>("/pt/categories"),
};

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 速率展示：formatBytes + "/s"，null 显示 "-" */
export function formatSpeed(n: number | null | undefined): string {
  if (n == null) return "-";
  return `${formatBytes(n)}/s`;
}

export function formatDuration(iso: string | null): string {
  if (!iso) return "-";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "-";
  if (ms < 60_000) return `${Math.round(ms / 1000)}秒`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}分钟`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}小时`;
  return `${(ms / 86_400_000).toFixed(1)}天`;
}

export function formatRelative(iso: string | null): string {
  if (!iso) return "-";
  const ms = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(ms);
  const suffix = ms >= 0 ? "前" : "后";
  if (abs < 60_000) return `${Math.round(abs / 1000)}秒${suffix}`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}分钟${suffix}`;
  if (abs < 86_400_000) return `${(abs / 3_600_000).toFixed(1)}小时${suffix}`;
  return `${(abs / 86_400_000).toFixed(1)}天${suffix}`;
}
