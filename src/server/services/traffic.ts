import { sql } from "drizzle-orm";
import { db, schema } from "../db";

/**
 * qBittorrent 的 uploaded/downloaded 是种子级单调累计值，但在种子被删除重加、
 * 换客户端实例等情况下会归零。差值为负时视为计数器重置，把当前值当作新增量。
 */
export function counterDelta(current: number, last: number): number {
  if (current >= last) return current - last;
  return current;
}

/** 服务器本地日期 YYYY-MM-DD（k8s 部署时用 TZ 环境变量控制日切时区） */
export function dayKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 把一次 reconcile 采样得到的流量增量累加进当日聚合 */
export async function addDailyTraffic(uploadedBytes: number, downloadedBytes: number): Promise<void> {
  if (uploadedBytes <= 0 && downloadedBytes <= 0) return;
  await db
    .insert(schema.trafficDaily)
    .values({ day: dayKey(), uploadedBytes, downloadedBytes })
    .onConflictDoUpdate({
      target: schema.trafficDaily.day,
      set: {
        uploadedBytes: sql`${schema.trafficDaily.uploadedBytes} + ${uploadedBytes}`,
        downloadedBytes: sql`${schema.trafficDaily.downloadedBytes} + ${downloadedBytes}`,
        updatedAt: new Date(),
      },
    });
}
