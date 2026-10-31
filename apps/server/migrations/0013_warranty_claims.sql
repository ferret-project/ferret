CREATE TABLE `warranty_claim` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`warranty_id` text NOT NULL,
	`item_id` text NOT NULL,
	`filed_on` text NOT NULL,
	`problem` text NOT NULL,
	`reference` text,
	`status` text DEFAULT 'filed' NOT NULL,
	`resolution` text,
	`resolved_on` text,
	`cost_cents` integer,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`warranty_id`) REFERENCES `warranty`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `item`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `warranty_claim_item_idx` ON `warranty_claim` (`household_id`,`item_id`);--> statement-breakpoint
CREATE INDEX `warranty_claim_warranty_idx` ON `warranty_claim` (`warranty_id`);