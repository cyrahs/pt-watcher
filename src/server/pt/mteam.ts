import type { FreeTorrent, PtAdapter } from "./types";

export interface MTeamOptions {
  apiKey: string;
  baseUrl?: string;
  /** search 的 mode 列表，如 ["normal"] 或 ["movie", "tvshow"] */
  modes?: string[];
  pageSize?: number;
}

interface MtStatus {
  discount?: string;
  discountEndTime?: string | null;
  seeders?: string | number;
  leechers?: string | number;
  timesCompleted?: string | number;
  mallSingleFree?: { status?: string; endDate?: string | null } | null;
}

interface MtTorrent {
  id: string | number;
  name?: string;
  size?: string | number;
  category?: string | number;
  status?: MtStatus;
}

const FREE_DISCOUNTS = new Set(["FREE", "_2X_FREE"]);

/** M-Team 时间字符串为东八区，无时区标记，固定按 UTC+8 解析 */
export function parseMtTime(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  const utcMs = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h) - 8,
    Number(mi),
    Number(se ?? 0),
  );
  return new Date(utcMs);
}

/** 三套 free 机制取有效者；非 free 返回 undefined，free 无到期返回 null */
export function effectiveFreeEnd(status: MtStatus | undefined): Date | null | undefined {
  if (!status) return undefined;
  if (status.mallSingleFree?.status === "ONGOING") {
    return parseMtTime(status.mallSingleFree.endDate);
  }
  if (status.discount && FREE_DISCOUNTS.has(status.discount)) {
    return parseMtTime(status.discountEndTime);
  }
  return undefined;
}

export class MTeamAdapter implements PtAdapter {
  readonly siteId = "mteam";
  private baseUrl: string;
  private apiKey: string;
  private modes: string[];
  private pageSize: number;
  private lastRequestAt = 0;

  constructor(opts: MTeamOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.m-team.cc/api").replace(/\/+$/, "");
    this.modes = opts.modes?.length ? opts.modes : ["normal"];
    this.pageSize = opts.pageSize ?? 100;
  }

  private authHeaders(): Record<string, string> {
    return { "x-api-key": this.apiKey };
  }

  /** API 节流：请求间隔 >= 1s */
  private async throttle() {
    const wait = this.lastRequestAt + 1000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }

  private async request<T>(path: string, init: RequestInit, retries = 1): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      await this.throttle();
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          ...init,
          headers: { ...this.authHeaders(), ...(init.headers as Record<string, string>) },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        const data = (await res.json()) as { code?: string | number; message?: string; data?: T };
        if (String(data.code) !== "0") throw new Error(data.message || `mteam code=${data.code}`);
        return data.data as T;
      } catch (e) {
        lastError = e;
        if (attempt < retries) await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new Error(`mteam ${path} failed: ${String(lastError)}`);
  }

  private toFreeTorrent(t: MtTorrent): FreeTorrent | null {
    const freeEnd = effectiveFreeEnd(t.status);
    if (freeEnd === undefined) return null;
    return {
      siteId: this.siteId,
      torrentId: String(t.id),
      name: t.name ?? `mteam-${t.id}`,
      sizeBytes: Number(t.size ?? 0),
      freeEndTime: freeEnd,
      seeders: Number(t.status?.seeders ?? 0),
      leechers: Number(t.status?.leechers ?? 0),
      snatched: Number(t.status?.timesCompleted ?? 0),
      category: t.category != null ? String(t.category) : undefined,
    };
  }

  private async search(body: Record<string, unknown>): Promise<MtTorrent[]> {
    const data = await this.request<{ data?: MtTorrent[] }>("/torrent/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return data?.data ?? [];
  }

  async searchFree(): Promise<FreeTorrent[]> {
    const results = new Map<string, FreeTorrent>();
    for (const mode of this.modes) {
      // 1) discount=FREE 过滤搜索
      const freeBatch = await this.search({
        mode,
        discount: "FREE",
        visible: 1,
        pageNumber: 1,
        pageSize: this.pageSize,
        sortDirection: "DESC",
        sortField: "CREATED_DATE",
      });
      // 2) 默认排序头部（mallSingleFree 等不会出现在 discount 过滤结果里）
      const headBatch = await this.search({
        mode,
        visible: 1,
        pageNumber: 1,
        pageSize: this.pageSize,
      });
      for (const t of [...freeBatch, ...headBatch]) {
        const ft = this.toFreeTorrent(t);
        if (ft && !results.has(ft.torrentId)) results.set(ft.torrentId, ft);
      }
    }
    return [...results.values()];
  }

  async getDetail(torrentId: string): Promise<FreeTorrent | null> {
    const form = new URLSearchParams({ id: torrentId });
    let t: MtTorrent | null;
    try {
      t = await this.request<MtTorrent>("/torrent/detail", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
    } catch {
      return null;
    }
    if (!t) return null;
    const ft = this.toFreeTorrent(t);
    // 非 free 也要返回基本信息（freeEndTime 置为过去，让调用方判定已到期）
    return (
      ft ?? {
        siteId: this.siteId,
        torrentId: String(t.id),
        name: t.name ?? `mteam-${t.id}`,
        sizeBytes: Number(t.size ?? 0),
        freeEndTime: new Date(0),
        seeders: Number(t.status?.seeders ?? 0),
        leechers: Number(t.status?.leechers ?? 0),
        snatched: Number(t.status?.timesCompleted ?? 0),
      }
    );
  }

  async fetchTorrentFile(torrentId: string): Promise<Uint8Array> {
    const url = await this.request<string>(`/torrent/genDlToken?id=${torrentId}`, {
      method: "POST",
    });
    if (!url) throw new Error("genDlToken returned empty url");
    await this.throttle();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download .torrent failed: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}
