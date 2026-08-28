CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"torrent_ref" text,
	"message" text NOT NULL,
	"payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "seen_site_torrents" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"site_torrent_id" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "torrents" (
	"id" serial PRIMARY KEY NOT NULL,
	"info_hash" text NOT NULL,
	"site_id" text,
	"site_torrent_id" text,
	"name" text NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'downloading' NOT NULL,
	"added_by_watcher" boolean DEFAULT false NOT NULL,
	"free_end_time" timestamp with time zone,
	"up_ema" double precision DEFAULT 0 NOT NULL,
	"last_uploaded_bytes" bigint DEFAULT 0 NOT NULL,
	"ratio" double precision DEFAULT 0 NOT NULL,
	"progress" double precision DEFAULT 0 NOT NULL,
	"seeders" integer DEFAULT 0 NOT NULL,
	"leechers" integer DEFAULT 0 NOT NULL,
	"qbit_popularity" double precision DEFAULT 0 NOT NULL,
	"score" double precision DEFAULT 0 NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stat_sampled_at" timestamp with time zone,
	"untracked_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "events_ts_idx" ON "events" USING btree ("ts");--> statement-breakpoint
CREATE UNIQUE INDEX "seen_site_torrent_idx" ON "seen_site_torrents" USING btree ("site_id","site_torrent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "torrents_info_hash_idx" ON "torrents" USING btree ("info_hash");--> statement-breakpoint
CREATE INDEX "torrents_state_idx" ON "torrents" USING btree ("state");