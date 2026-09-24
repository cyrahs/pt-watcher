import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { runMigrations } from "./db/migrate";
import { buildInfo, env, getSettings, loadSettings } from "./config";
import { logEvent } from "./services/events";
import { SNAPSHOT_CHECK_INTERVAL_SEC, snapshotTick } from "./jobs/snapshot";
import { api } from "./api/routes";
import { registerJob, startScheduler } from "./jobs/scheduler";
import { discover } from "./jobs/discover";
import { freeGuard } from "./jobs/freeGuard";
import { diskGuardTick } from "./jobs/diskGuard";
import { reconcile } from "./jobs/reconcile";

async function main() {
  await runMigrations();
  await loadSettings();

  registerJob("reconcile", reconcile, () => getSettings().reconcileIntervalSec);
  registerJob("freeGuard", freeGuard, () => getSettings().freeGuardIntervalSec);
  registerJob("discover", discover, () => getSettings().discoverIntervalSec);
  registerJob("diskGuard", diskGuardTick, () => getSettings().diskCheckIntervalSec);
  registerJob("snapshot", snapshotTick, () => SNAPSHOT_CHECK_INTERVAL_SEC);
  await logEvent("app_started", `pt-watcher 启动（版本 ${buildInfo.gitSha ?? "unknown"}）`, {
    payload: buildInfo,
  });
  startScheduler();

  const app = new Hono();
  app.route("/api", api);
  // 未知 API 路径返回 JSON 404，而不是落到下面的 SPA 回退返回 index.html
  app.all("/api/*", (c) => c.json({ error: "not found", index: "/api" }, 404));
  app.use("/*", serveStatic({ root: "./dist/web" }));
  app.use("/*", serveStatic({ root: "./dist/web", path: "index.html" }));

  Bun.serve({ port: env.port, fetch: app.fetch });
  console.log(`pt-watcher listening on :${env.port}`);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
