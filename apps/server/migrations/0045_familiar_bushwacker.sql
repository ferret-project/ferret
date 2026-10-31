CREATE TABLE `collection` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`template_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_id`) REFERENCES `item_template`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `collection_household_idx` ON `collection` (`household_id`);--> statement-breakpoint
ALTER TABLE `item` ADD `collection_id` text REFERENCES collection(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `item` ADD `wanted` integer DEFAULT false NOT NULL;