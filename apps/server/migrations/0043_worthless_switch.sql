CREATE TABLE `room_scan` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`location_id` text,
	`container_item_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`photo_count` integer NOT NULL,
	`candidates` text,
	`error` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`location_id`) REFERENCES `location`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`container_item_id`) REFERENCES `item`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `room_scan_household_idx` ON `room_scan` (`household_id`,`status`);--> statement-breakpoint
ALTER TABLE `item` ADD `room_scan_id` text REFERENCES room_scan(id) ON DELETE set null;