import { db, schema } from "../db";

export async function logEvent(
  type: string,
  message: string,
  opts: { torrentRef?: string; payload?: unknown } = {},
) {
  console.log(`[event:${type}] ${message}`);
  try {
    await db.insert(schema.events).values({
      type,
      message,
      torrentRef: opts.torrentRef,
      payload: opts.payload ?? null,
    });
  } catch (e) {
    console.error("logEvent failed:", e);
  }
}
