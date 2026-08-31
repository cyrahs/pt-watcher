import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { qbit } from "../qbit/client";
import { logEvent } from "./events";

/**
 * 下载阻断控制：合并多来源阻断原因，物理上"只停下载、保留上传"。
 *
 * 机制（交接文稿 §6.4）：
 * - 首选 file_prio：把全部文件置为"不下载"（priority 0），已有分片继续上传。
 * - filePrio 不可用（无元数据/旧版本）时降级为整体 stop，并显式记录降级事件
 *   （上传也被停止——这是实现缺口，不是等价实现）。
 * - 解除全部原因后恢复：file_prio 机制恢复文件优先级为正常并 start；
 *   注意会把收养前用户手动反选的文件也置回下载（一期已知限制）。
 */

type TorrentRow = typeof schema.torrents.$inferSelect;
type Block = { reasons: string[]; mechanism: "file_prio" | "stopped" | null };

export function currentBlock(row: TorrentRow): Block {
  return row.downloadBlock ?? { reasons: [], mechanism: null };
}

export async function blockDownload(row: TorrentRow, reason: string): Promise<void> {
  const block = currentBlock(row);
  if (block.reasons.includes(reason) && block.mechanism) return;

  let mechanism = block.mechanism;
  if (!mechanism) {
    try {
      const files = await qbit.torrentFiles(row.infoHash);
      if (files.length === 0) throw new Error("文件列表为空（元数据未就绪）");
      await qbit.setFilePrio(row.infoHash, files.map((f) => f.index), 0);
      mechanism = "file_prio";
    } catch (e) {
      // 降级：整体停止（上传一起停）。显式记录实现缺口，不悄悄退化。
      await qbit.stopTorrents([row.infoHash]);
      mechanism = "stopped";
      await logEvent(
        "download_block_degraded",
        `无法按文件级阻断下载（${String(e)}），已降级为整体停止（上传也被停止）: ${row.name}`,
        { torrentRef: row.infoHash },
      );
    }
  }

  const reasons = block.reasons.includes(reason) ? block.reasons : [...block.reasons, reason];
  await db
    .update(schema.torrents)
    .set({ downloadBlock: { reasons, mechanism } })
    .where(eq(schema.torrents.id, row.id));
}

/** 移除一个阻断原因；全部原因清空后才物理恢复下载（清除一个原因不清除其他原因） */
export async function unblockDownload(row: TorrentRow, reason: string): Promise<void> {
  const block = currentBlock(row);
  const reasons = block.reasons.filter((r) => r !== reason);
  if (reasons.length > 0) {
    await db
      .update(schema.torrents)
      .set({ downloadBlock: { reasons, mechanism: block.mechanism } })
      .where(eq(schema.torrents.id, row.id));
    return;
  }

  await physicallyResume(row, block.mechanism);
  await db
    .update(schema.torrents)
    .set({ downloadBlock: { reasons: [], mechanism: null } })
    .where(eq(schema.torrents.id, row.id));
}

/** 手动恢复：一次性清除全部阻断原因并物理恢复下载（用户显式操作） */
export async function clearAllBlocks(row: TorrentRow): Promise<void> {
  const block = currentBlock(row);
  await physicallyResume(row, block.mechanism);
  await db
    .update(schema.torrents)
    .set({ downloadBlock: { reasons: [], mechanism: null } })
    .where(eq(schema.torrents.id, row.id));
}

async function physicallyResume(row: TorrentRow, mechanism: Block["mechanism"]): Promise<void> {
  if (mechanism === "file_prio") {
    const files = await qbit.torrentFiles(row.infoHash);
    await qbit.setFilePrio(row.infoHash, files.map((f) => f.index), 1);
  }
  await qbit.startTorrents([row.infoHash]);
}
