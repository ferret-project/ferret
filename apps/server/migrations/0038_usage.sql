CREATE TABLE `usage_reading` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`item_id` text NOT NULL,
	`value` real NOT NULL,
	`read_on` text NOT NULL,
	`note` text,
	`user_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `item`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `usage_reading_item_idx` ON `usage_reading` (`household_id`,`item_id`,`read_on`);--> statement-breakpoint
ALTER TABLE `item` ADD `usage_unit` text;--> statement-breakpoint
ALTER TABLE `maintenance_task` ADD `time_due_on` text;--> statement-breakpoint
ALTER TABLE `maintenance_task` ADD `usage_every` integer;--> statement-breakpoint
ALTER TABLE `maintenance_task` ADD `usage_due_at` real;--> statement-breakpoint
-- Every task so far is due by time alone.
UPDATE `maintenance_task` SET `time_due_on` = `due_on`;
