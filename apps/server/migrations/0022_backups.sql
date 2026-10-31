CREATE TABLE `backup_run` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`snapshot` text,
	`db_bytes` integer,
	`files` integer,
	`files_copied` integer,
	`files_bytes` integer,
	`checked` text,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `server_setting` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
