CREATE TABLE "traffic_daily" (
	"day" text PRIMARY KEY NOT NULL,
	"uploaded_bytes" bigint DEFAULT 0 NOT NULL,
	"downloaded_bytes" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "torrents" ADD COLUMN "last_downloaded_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "torrents" ADD COLUMN "total_uploaded_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "torrents" ADD COLUMN "total_downloaded_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
-- 已有种子的下载计数器基线用 size*progress 近似（qBit 的 downloaded 无法在迁移中获取），
-- 避免升级后的首次 reconcile 把历史下载量整块计入当天
UPDATE "torrents" SET "last_downloaded_bytes" = ROUND("size_bytes" * "progress");