CREATE TABLE `repair` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`item_id` text NOT NULL,
	`repaired_on` text NOT NULL,
	`problem` text,
	`work` text NOT NULL,
	`provider_id` text,
	`parts` text,
	`cost_cents` integer,
	`warranty_id` text,
	`task_id` text,
	`done_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `item`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_id`) REFERENCES `provider`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`warranty_id`) REFERENCES `warranty`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`task_id`) REFERENCES `maintenance_task`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`done_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `repair_item_idx` ON `repair` (`household_id`,`item_id`);--> statement-breakpoint
ALTER TABLE `attachment` ADD `repair_id` text REFERENCES repair(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `item` ADD `replaced_by_id` text REFERENCES item(id) ON DELETE set null;