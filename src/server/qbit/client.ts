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

  async freeSpaceOnDisk(): Promise<number> {
    const res = await this.request("/sync/maindata?rid=0");
    const data = (await res.json()) as { server_state?: { free_space_on_disk?: number } };
    return data.server_state?.free_space_on_disk ?? 0;
  }
}

export const qbit = new QbitClient();
