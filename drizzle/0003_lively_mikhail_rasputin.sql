CREATE TABLE "discover_candidates" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"site_torrent_id" text NOT NULL,
	"name" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"site_category" text,
	"free_end_time" timestamp with time zone,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"seen_count" integer DEFAULT 1 NOT NULL,
	"seeders" integer NOT NULL,
	"leechers" integer NOT NULL,
	"snatched" integer NOT NULL,
	"last_seeders" integer NOT NULL,
	"last_leechers" integer NOT NULL,
	"last_snatched" integer NOT NULL,
	"decision" text NOT NULL,
	"reason" text,
	"rank" integer,
	"added_at" timestamp with time zone,
	"info_hash" text
);
--> statement-breakpoint
CREATE TABLE "system_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"git_sha" text,
	"qbit_connected" boolean NOT NULL,
	"free_bytes" bigint,
	"managed_used_bytes" bigint,
	"dl_speed_bytes_per_sec" double precision,
	"up_speed_bytes_per_sec" double precision,
	"pressure_state" text NOT NULL,
	"pending_release_bytes" bigint DEFAULT 0 NOT NULL,
	"torrent_counts" jsonb NOT NULL,
	"site_stats" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "torrent_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"torrent_id" integer NOT NULL,
	"state" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"progress" double precision NOT NULL,
	"total_uploaded_bytes" bigint NOT NULL,
	"total_downloaded_bytes" bigint NOT NULL,
	"up_ema" double precision,
	"seeders" integer NOT NULL,
	"leechers" integer NOT NULL,
	"ratio" double precision NOT NULL,
	"expected_upload_bytes" double precision,
	"prediction_kind" text,
	"prediction_horizon_sec" integer
);
--> statement-breakpoint
CREATE INDEX "discover_candidates_site_idx" ON "discover_candidates" USING btree ("site_id","site_torrent_id");--> statement-breakpoint
CREATE INDEX "discover_candidates_last_seen_idx" ON "discover_candidates" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "system_snapshots_ts_idx" ON "system_snapshots" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "torrent_snapshots_ts_idx" ON "torrent_snapshots" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "torrent_snapshots_torrent_ts_idx" ON "torrent_snapshots" USING btree ("torrent_id","ts");