export interface FreeTorrent {
  siteId: string;
  torrentId: string;
  name: string;
  sizeBytes: number;
  /** null = 不限时 free */
  freeEndTime: Date | null;
  seeders: number;
  leechers: number;
  snatched: number;
  category?: string;
  /** 站点上不是 free，只因账号处于不计下载量的 VIP 期而入选（freeEndTime = VIP 到期时间） */
  vipOnly?: boolean;
}

export interface PtCategory {
  siteId: string;
  id: string;
  name: string;
  /** 所属搜索分组，如 adult/movie/music/tvshow/anime/normal */
  group: string;
}

export interface SiteUserStats {
  siteId: string;
  username: string | null;
  uploadedBytes: number;
  downloadedBytes: number;
  /** null = 无下载量（∞） */
  shareRate: number | null;
  bonus: number | null;
  /** 账号不计下载量的 VIP 期截止时间（ISO）；null = 不在 VIP 期或未启用 */
  vipUntil?: string | null;
}

export interface PtAdapter {
  siteId: string;
  /** 站点的可选分类列表（叶子分类），用于 UI 勾选过滤 */
  listCategories?(): Promise<PtCategory[]>;
  /** 站点账号总量统计（上传/下载/分享率），实现方应自带缓存以承受高频轮询 */
  getUserStats?(): Promise<SiteUserStats | null>;
  /**
   * 账号级"下载不计量"窗口（如 M-Team VIP）的截止时间；null = 当前不适用。
   * 窗口内站点上非 free 的种子也视为 free（freeEndTime = 窗口截止）。
   */
  accountFreeUntil?(): Promise<Date | null>;
  /** 拉当前 FREE 种子列表（含 mallSingleFree 等站点特有 free 机制） */
  searchFree(): Promise<FreeTorrent[]>;
  /** 单种子最新状态（free 是否延期/取消）；返回 null 表示种子已不存在 */
  getDetail(torrentId: string): Promise<FreeTorrent | null>;
  /** 获取 .torrent 文件字节 */
  fetchTorrentFile(torrentId: string): Promise<Uint8Array>;
}
