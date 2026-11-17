CREATE TABLE `item_video` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`item_id` text NOT NULL,
	`video_id` text NOT NULL,
	`title` text,
	`channel` text,
	`seconds` integer,
	`added_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `item`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`added_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `item_video_item_idx` ON `item_video` (`household_id`,`item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `item_video_once` ON `item_video` (`item_id`,`video_id`);