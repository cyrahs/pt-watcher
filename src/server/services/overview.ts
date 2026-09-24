import { qbit } from "../qbit/client";

export interface QbitOverview {
  connected: boolean;
  freeBytes: number | null;
  /** 全局实时速度（B/s），字段缺失时 null */
  dlSpeed: number | null;
  upSpeed: number | null;
  /** 受管种子已占用的磁盘空间（已下载的选中字节数） */
  managedUsedBytes: number | null;
}

/** qBittorrent 现状一览（/status 与系统快照共用）；未配置或不可达时 connected=false、数值为 null */
export async function qbitOverview(managedCategories: string[]): Promise<QbitOverview> {
  const empty: QbitOverview = {
    connected: false,
    freeBytes: null,
    dlSpeed: null,
    upSpeed: null,
    managedUsedBytes: null,
  };
  if (!qbit.configured) return empty;
  try {
    const obs = await qbit.diskObservation();
    const infos = await Promise.all(
      managedCategories.map((cat) => qbit.torrentsInfo({ category: cat })),
    );
    return {
      connected: true,
      freeBytes: obs.freeBytes,
      dlSpeed: obs.dlSpeed,
      upSpeed: obs.upSpeed,
      managedUsedBytes: infos.flat().reduce((sum, t) => sum + Math.max(t.size - t.amount_left, 0), 0),
    };
  } catch {
    return empty;
  }
}
