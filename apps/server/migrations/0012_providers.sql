CREATE TABLE `provider` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`trade` text,
	`contact_name` text,
	`phone` text,
	`email` text,
	`website` text,
	`address` text,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `provider_household_idx` ON `provider` (`household_id`);--> statement-breakpoint
ALTER TABLE `maintenance_log` ADD `provider_id` text REFERENCES provider(id);--> statement-breakpoint
ALTER TABLE `maintenance_task` ADD `provider_id` text REFERENCES provider(id);