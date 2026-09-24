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
CREATE INDEX "torrent_snapshots_ts_idx" ON "torrent_snapshots" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "torrent_snapshots_torrent_ts_idx" ON "torrent_snapshots" USING btree ("torrent_id","ts");