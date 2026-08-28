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
  score: number;
  addedAt: string;
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

export interface Status {
  qbit: { configured: boolean; connected: boolean; url: string };
  mteam: { configured: boolean };
  freeSpaceBytes: number | null;
  freeSpaceThresholdBytes: number;
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
