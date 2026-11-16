CREATE TABLE `task_video` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`task_id` text NOT NULL,
	`video_id` text NOT NULL,
	`title` text,
	`channel` text,
	`seconds` integer,
	`added_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `maintenance_task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`added_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `task_video_task_idx` ON `task_video` (`household_id`,`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_video_once` ON `task_video` (`task_id`,`video_id`);--> statement-breakpoint
CREATE TABLE `video_search` (
	`query` text PRIMARY KEY NOT NULL,
	`results` text NOT NULL,
	`checked_at` integer NOT NULL
);
