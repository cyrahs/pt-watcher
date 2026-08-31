CREATE TABLE "eviction_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"volume_key" text NOT NULL,
	"trigger_reason" text DEFAULT 'observed_below_threshold' NOT NULL,
	"actual_free_bytes" bigint NOT NULL,
	"threshold_bytes" bigint NOT NULL,
	"need_bytes" bigint NOT NULL,
	"status" text NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"plan" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "seen_site_torrents" ADD COLUMN "free_end_time" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "torrents" ADD COLUMN "ema_initialized" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "torrents" ADD COLUMN "expected_upload_bytes" double precision;--> statement-breakpoint
ALTER TABLE "torrents" ADD COLUMN "prediction_kind" text;--> statement-breakpoint
ALTER TABLE "torrents" ADD COLUMN "predicted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "torrents" ADD COLUMN "download_block" jsonb;--> statement-breakpoint
CREATE INDEX "eviction_plans_created_idx" ON "eviction_plans" USING btree ("created_at");--> statement-breakpoint
-- 数据回填：旧模型下 up_ema>0 的行视为已初始化（保留其平滑状态；0 在旧模型里兼作未初始化标记）
UPDATE "torrents" SET "ema_initialized" = true WHERE "up_ema" > 0;--> statement-breakpoint
-- 存量 free 到期停种迁移为“下载受 free 阻断”语义：旧 freeGuard 用整体 stop（上传也被停止），
-- mechanism 如实记录为 stopped；再次 free 或手动恢复时按新路径解除
UPDATE "torrents" SET "download_block" = '{"reasons":["free_expired"],"mechanism":"stopped"}'::jsonb
WHERE "state" = 'stopped_free_expired' AND "download_block" IS NULL;