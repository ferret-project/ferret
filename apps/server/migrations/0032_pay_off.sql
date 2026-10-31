CREATE TABLE `coverage_limit` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`label` text NOT NULL,
	`limit_cents` integer NOT NULL,
	`scope` text NOT NULL,
	`property_id` text,
	`category_id` text,
	`tag` text,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`property_id`) REFERENCES `property`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `category`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `coverage_limit_household_idx` ON `coverage_limit` (`household_id`);--> statement-breakpoint
CREATE TABLE `item_recall` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`item_id` text NOT NULL,
	`recall_id` text NOT NULL,
	`match` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`resolved_at` integer,
	`resolved_by` text,
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `item`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recall_id`) REFERENCES `recall`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resolved_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `item_recall_pair_idx` ON `item_recall` (`item_id`,`recall_id`);--> statement-breakpoint
CREATE INDEX `item_recall_household_idx` ON `item_recall` (`household_id`,`status`);--> statement-breakpoint
CREATE TABLE `person_setting` (
	`household_id` text NOT NULL,
	`user_id` text NOT NULL,
	`weekly_day` integer,
	`weekly_email` integer DEFAULT false NOT NULL,
	`last_weekly_on` text,
	PRIMARY KEY(`household_id`, `user_id`),
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `recall` (
	`id` text PRIMARY KEY NOT NULL,
	`number` text,
	`recalled_on` text NOT NULL,
	`title` text NOT NULL,
	`url` text,
	`description` text,
	`hazard` text,
	`remedy` text,
	`contact` text,
	`products` text NOT NULL,
	`companies` text NOT NULL,
	`upcs` text NOT NULL,
	`image_url` text,
	`search_text` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recall_date_idx` ON `recall` (`recalled_on`);