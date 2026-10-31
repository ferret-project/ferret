CREATE TABLE `label` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`code` text NOT NULL,
	`item_id` text,
	`location_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `item`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`location_id`) REFERENCES `location`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `label_code_unique` ON `label` (`code`);--> statement-breakpoint
CREATE INDEX `label_item_idx` ON `label` (`household_id`,`item_id`);--> statement-breakpoint
CREATE INDEX `label_location_idx` ON `label` (`household_id`,`location_id`);--> statement-breakpoint
ALTER TABLE `item` ADD `is_container` integer DEFAULT false NOT NULL;