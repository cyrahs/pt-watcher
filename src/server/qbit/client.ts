import { getSettings } from "../config";

export interface QbitTorrentInfo {
  hash: string;
  name: string;
  size: number;
  amount_left: number;
  progress: number;
  ratio: number;
  uploaded: number;
  downloaded: number;
  upspeed: number;
  num_complete: number;
  num_incomplete: number;
  popularity?: number;
  added_on: number;
  category: string;
  tags: string;
  state: string;
}

export interface QbitCredentials {
  baseUrl: string;
  apiKey: string;
}

export class QbitClient {
  private overrides: Partial<QbitCredentials>;
  private stopVerb: "stop" | "pause" | null = null;

  /** 不传 overrides 时凭据实时取自 settings；传入则用于临时连接（如测试） */
  constructor(overrides: Partial<QbitCredentials> = {}) {
    this.overrides = overrides;
  }

  /** settings 每次读取，UI 修改后无需重启即生效 */
  private get baseUrl(): string {
    return (this.overrides.baseUrl ?? getSettings().qbitUrl).replace(/\/+$/, "");
  }

  private get apiKey(): string {
    return this.overrides.apiKey ?? getSettings().qbitApiKey;
  }

  get configured(): boolean {
    return Boolean(this.baseUrl && this.apiKey);
  }

  /** 连接配置变更后调用，丢弃版本探测结果 */
  resetConnection(): void {
    this.stopVerb = null;
  }

  /** qBit >= 5.2 的 API key 认证：Authorization: Bearer，无状态无 cookie */
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.baseUrl) throw new Error("qBittorrent 未配置（请在设置页填写 WebUI 地址）");
    if (!this.apiKey) throw new Error("qBittorrent 未配置 API key（请在设置页填写，需 qBittorrent ≥ 5.2）");
    const res = await fetch(`${this.baseUrl}/api/v2${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.apiKey}`, ...(init.headers as Record<string, string>) },
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`qBittorrent ${path}: HTTP ${res.status} (API key 无效或已轮换)`);
    }
    if (!res.ok) throw new Error(`qBittorrent ${path}: HTTP ${res.status}`);
    return res;
  }

  private async form(path: string, params: Record<string, string>): Promise<void> {
    await this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
  }

  async webApiVersion(): Promise<string> {
    const res = await this.request("/app/webapiVersion");
    return res.text();
  }

  async appVersion(): Promise<string> {
    const res = await this.request("/app/version");
    return res.text();
  }

  /** qBit 5.x 用 stop/start，旧版 pause/resume */
  private async resolveStopVerb(): Promise<"stop" | "pause"> {
    if (this.stopVerb) return this.stopVerb;
    const v = await this.webApiVersion();
    const [major = 0, minor = 0] = v.trim().split(".").map(Number);
    this.stopVerb = major > 2 || (major === 2 && minor >= 11) ? "stop" : "pause";
    return this.stopVerb;
  }

  async torrentsInfo(filter: { category?: string; hashes?: string[] } = {}): Promise<QbitTorrentInfo[]> {
    const q = new URLSearchParams();
    if (filter.category !== undefined) q.set("category", filter.category);
    if (filter.hashes?.length) q.set("hashes", filter.hashes.join("|"));
    const res = await this.request(`/torrents/info?${q.toString()}`);
    return (await res.json()) as QbitTorrentInfo[];
  }

  async addTorrentFile(
    file: Uint8Array,
    opts: { filename: string; category: string; tags: string },
  ): Promise<void> {
    const fd = new FormData();
    fd.append("torrents", new Blob([file as BlobPart], { type: "application/x-bittorrent" }), opts.filename);
    fd.append("category", opts.category);
    fd.append("tags", opts.tags);
    const res = await this.request("/torrents/add", { method: "POST", body: fd });
    const text = await res.text();
    if (text.trim() === "Fails.") throw new Error("qBittorrent torrents/add returned Fails.");
  }

  async stopTorrents(hashes: string[]): Promise<void> {
    if (!hashes.length) return;
    const verb = await this.resolveStopVerb();
    await this.form(`/torrents/${verb}`, { hashes: hashes.join("|") });
  }

  async startTorrents(hashes: string[]): Promise<void> {
    if (!hashes.length) return;
    const verb = (await this.resolveStopVerb()) === "stop" ? "start" : "resume";
    await this.form(`/torrents/${verb}`, { hashes: hashes.join("|") });
  }

  async deleteTorrents(hashes: string[], deleteFiles: boolean): Promise<void> {
    if (!hashes.length) return;
    await this.form("/torrents/delete", {
      hashes: hashes.join("|"),
      deleteFiles: String(deleteFiles),
    });
  }

  async setCategory(hashes: string[], category: string): Promise<void> {
    if (!hashes.length) return;
    await this.form("/torrents/setCategory", { hashes: hashes.join("|"), category });
  }

  /**
   * 默认保存路径所在卷的实际剩余空间。
   * 字段缺失/非法时返回 null（未知 ≠ 0 字节；调用方不得据 null 触发删除）。
   */
  async freeSpaceOnDisk(): Promise<number | null> {
    return (await this.diskObservation()).freeBytes;
  }

  /**
   * 剩余空间 + 会话累计下载字节（dl_info_data，qBittorrent 重启归零）+ 全局实时上下行速度。
   * 累计下载用于 diskGuard 把并发下载写入从空间变化里扣掉，核对删除释放是否到账。
   * qBittorrent 的 free_space_on_disk 由后台线程约每 30s 刷新一次，读到的值可能滞后。
   */
  async diskObservation(): Promise<{
    freeBytes: number | null;
    downloadedBytes: number | null;
    /** 全局下载速度（B/s），字段缺失时 null */
    dlSpeed: number | null;
    /** 全局上传速度（B/s），字段缺失时 null */
    upSpeed: number | null;
  }> {
    const res = await this.request("/sync/maindata?rid=0");
    const data = (await res.json()) as {
      server_state?: {
        free_space_on_disk?: number;
        dl_info_data?: number;
        dl_info_speed?: number;
        up_info_speed?: number;
      };
    };
    const nonNeg = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
    return {
      freeBytes: nonNeg(data.server_state?.free_space_on_disk),
      downloadedBytes: nonNeg(data.server_state?.dl_info_data),
      dlSpeed: nonNeg(data.server_state?.dl_info_speed),
      upSpeed: nonNeg(data.server_state?.up_info_speed),
    };
  }

  async torrentFiles(hash: string): Promise<{ index: number; priority: number }[]> {
    const res = await this.request(`/torrents/files?hash=${encodeURIComponent(hash)}`);
    const files = (await res.json()) as { index?: number; priority: number }[];
    // 旧版 API 无 index 字段时按数组下标
    return files.map((f, i) => ({ index: f.index ?? i, priority: f.priority }));
  }

  /** priority 0 = 不下载（已有分片仍参与上传）；1 = 正常 */
  async setFilePrio(hash: string, fileIds: number[], priority: number): Promise<void> {
    if (!fileIds.length) return;
    await this.form("/torrents/filePrio", {
      hash,
      id: fileIds.join("|"),
      priority: String(priority),
    });
  }
}

export const qbit = new QbitClient();
