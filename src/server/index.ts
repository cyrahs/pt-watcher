import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { runMigrations } from "./db/migrate";
import { env, getSettings, loadSettings } from "./config";
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
