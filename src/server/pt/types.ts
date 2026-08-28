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
}

export interface PtAdapter {
  siteId: string;
  /** 拉当前 FREE 种子列表（含 mallSingleFree 等站点特有 free 机制） */
  searchFree(): Promise<FreeTorrent[]>;
  /** 单种子最新状态（free 是否延期/取消）；返回 null 表示种子已不存在 */
  getDetail(torrentId: string): Promise<FreeTorrent | null>;
  /** 获取 .torrent 文件字节 */
  fetchTorrentFile(torrentId: string): Promise<Uint8Array>;
}
