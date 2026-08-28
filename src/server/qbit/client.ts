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

export class QbitClient {
  private baseUrlOverride: string | null;
  private cookie = "";
  private stopVerb: "stop" | "pause" | null = null;

  constructor(baseUrl?: string) {
    this.baseUrlOverride = baseUrl ?? null;
  }

  /** settings 每次读取，UI 修改后无需重启即生效 */
  private get baseUrl(): string {
    return (this.baseUrlOverride ?? getSettings().qbitUrl).replace(/\/+$/, "");
  }

  get configured(): boolean {
    return Boolean(this.baseUrl);
  }

  /** 连接配置变更后调用，丢弃旧会话与版本探测结果 */
  resetConnection(): void {
    this.cookie = "";
    this.stopVerb = null;
  }

  private async login(): Promise<void> {
    const s = getSettings();
    const res = await fetch(`${this.baseUrl}/api/v2/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: s.qbitUser, password: s.qbitPass }).toString(),
    });
    const text = await res.text();
    if (!res.ok || text.trim() !== "Ok.") {
      throw new Error(`qBittorrent login failed: HTTP ${res.status} ${text.slice(0, 100)}`);
    }
    const setCookie = res.headers.get("set-cookie") ?? "";
    const m = setCookie.match(/SID=[^;]+/);
    if (!m) throw new Error("qBittorrent login: no SID cookie");
    this.cookie = m[0];
  }

  private async request(path: string, init: RequestInit = {}, retryAuth = true): Promise<Response> {
    if (!this.baseUrl) throw new Error("qBittorrent 未配置（请在设置页填写 WebUI 地址）");
    if (!this.cookie) await this.login();
    const res = await fetch(`${this.baseUrl}/api/v2${path}`, {
      ...init,
      headers: { Cookie: this.cookie, ...(init.headers as Record<string, string>) },
    });
    if (res.status === 403 && retryAuth) {
      this.cookie = "";
      return this.request(path, init, false);
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
