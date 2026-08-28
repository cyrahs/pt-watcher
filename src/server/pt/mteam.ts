import type { FreeTorrent, PtAdapter, PtCategory } from "./types";

export interface MTeamOptions {
  apiKey: string;
  baseUrl?: string;
  /** search 的 mode 列表，如 ["normal"] 或 ["movie", "tvshow"]；配置了 categories 时忽略 */
  modes?: string[];
  /** 只搜索这些分类 id（叶子分类），mode 按分类归属自动推导 */
  categories?: string[];
  pageSize?: number;
}

interface MtCategoryEntry {
  id: string | number;
  nameChs?: string;
  nameCht?: string;
  nameEng?: string;
  parent?: string | number | null;
}

interface MtCategoryList {
  list?: MtCategoryEntry[];
  [group: string]: unknown;
}

/** categoryList 响应里 mode 分组的 key（waterfall 是全集视图，排除） */
const CATEGORY_GROUPS = ["adult", "movie", "music", "tvshow", "anime"] as const;
/** search API 支持的 mode；分组不在其中的（如 anime）归入 normal 模式搜索 */
const SEARCH_MODES = new Set(["normal", "adult", "movie", "music", "tvshow"]);

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
  private categories: string[];
  private pageSize: number;
  private lastRequestAt = 0;
  private categoryCache: { at: number; list: PtCategory[] } | null = null;

  constructor(opts: MTeamOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.m-team.cc/api").replace(/\/+$/, "");
    this.modes = opts.modes?.length ? opts.modes : ["normal"];
    this.categories = opts.categories ?? [];
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

  async listCategories(): Promise<PtCategory[]> {
    if (this.categoryCache && Date.now() - this.categoryCache.at < 3600_000) {
      return this.categoryCache.list;
    }
    const data = await this.request<MtCategoryList>("/torrent/categoryList", { method: "POST" });
    const entries = data?.list ?? [];
    const parentIds = new Set(entries.map((e) => String(e.parent ?? "")).filter(Boolean));
    const groupOf = new Map<string, string>();
    for (const group of CATEGORY_GROUPS) {
      for (const id of (data?.[group] as (string | number)[] | undefined) ?? []) {
        groupOf.set(String(id), group);
      }
    }
    const list = entries
      .filter((e) => !parentIds.has(String(e.id))) // 只保留叶子分类
      .map((e) => ({
        siteId: this.siteId,
        id: String(e.id),
        name: e.nameChs || e.nameCht || e.nameEng || String(e.id),
        group: groupOf.get(String(e.id)) ?? "normal",
      }));
    this.categoryCache = { at: Date.now(), list };
    return list;
  }

  /** 生成搜索计划：每个 mode 一项，可带分类过滤 */
  private async searchPlans(): Promise<{ mode: string; categories?: number[] }[]> {
    if (this.categories.length === 0) {
      return this.modes.map((mode) => ({ mode }));
    }
    // 按分类归属的分组推导 mode（anime 等无对应 mode 的归入 normal 搜索）
    const groupOf = new Map((await this.listCategories()).map((c) => [c.id, c.group]));
    const byMode = new Map<string, number[]>();
    for (const id of this.categories) {
      const group = groupOf.get(id) ?? "normal";
      const mode = SEARCH_MODES.has(group) && group !== "normal" ? group : "normal";
      byMode.set(mode, [...(byMode.get(mode) ?? []), Number(id)]);
    }
    return [...byMode.entries()].map(([mode, categories]) => ({ mode, categories }));
  }

  async searchFree(): Promise<FreeTorrent[]> {
    const results = new Map<string, FreeTorrent>();
    for (const plan of await this.searchPlans()) {
      const base = {
        mode: plan.mode,
        ...(plan.categories?.length ? { categories: plan.categories } : {}),
        visible: 1,
        pageNumber: 1,
        pageSize: this.pageSize,
      };
      // 1) discount=FREE 过滤搜索
      const freeBatch = await this.search({
        ...base,
        discount: "FREE",
        sortDirection: "DESC",
        sortField: "CREATED_DATE",
      });
      // 2) 默认排序头部（mallSingleFree 等不会出现在 discount 过滤结果里）
      const headBatch = await this.search(base);
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
