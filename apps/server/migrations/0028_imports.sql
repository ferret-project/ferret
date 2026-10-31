CREATE TABLE `import_batch` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`source` text NOT NULL,
	`name` text NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`undone_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `import_batch_household_idx` ON `import_batch` (`household_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `item` ADD `import_batch_id` text REFERENCES import_batch(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `item` ADD `ha_device_id` text;--> statement-breakpoint
CREATE INDEX `item_ha_device_idx` ON `item` (`household_id`,`ha_device_id`);