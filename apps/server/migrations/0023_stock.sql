CREATE TABLE `stock_movement` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`item_id` text NOT NULL,
	`delta` integer NOT NULL,
	`quantity_after` integer NOT NULL,
	`reason` text NOT NULL,
	`note` text,
	`user_id` text,
	`via` text NOT NULL,
	`undone_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `item`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `stock_movement_item_idx` ON `stock_movement` (`household_id`,`item_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `stock_rule` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`code` text NOT NULL,
	`item_id` text NOT NULL,
	`behaviour` text DEFAULT 'lookup' NOT NULL,
	`step` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `item`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_rule_code_item_idx` ON `stock_rule` (`household_id`,`code`,`item_id`);--> statement-breakpoint
CREATE INDEX `stock_rule_item_idx` ON `stock_rule` (`household_id`,`item_id`);