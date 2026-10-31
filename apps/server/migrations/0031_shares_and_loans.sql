CREATE TABLE `loan` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`item_id` text NOT NULL,
	`direction` text NOT NULL,
	`person` text NOT NULL,
	`email` text,
	`since` text NOT NULL,
	`due_on` text,
	`note` text,
	`remind_every` text,
	`last_reminded_on` text,
	`token_hash` text,
	`token_sealed` text,
	`borrower_returned_at` integer,
	`reminders_stopped_at` integer,
	`returned_on` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `item`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `loan_household_idx` ON `loan` (`household_id`,`returned_on`);--> statement-breakpoint
CREATE INDEX `loan_item_idx` ON `loan` (`item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `loan_token_idx` ON `loan` (`token_hash`);--> statement-breakpoint
CREATE TABLE `share_link` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`kind` text NOT NULL,
	`property_id` text,
	`tag` text,
	`category_id` text,
	`label` text,
	`include_files` integer DEFAULT true NOT NULL,
	`token_hash` text NOT NULL,
	`token_sealed` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`views` integer DEFAULT 0 NOT NULL,
	`last_viewed_at` integer,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`property_id`) REFERENCES `property`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `category`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `share_link_token_idx` ON `share_link` (`token_hash`);--> statement-breakpoint
CREATE INDEX `share_link_household_idx` ON `share_link` (`household_id`);--> statement-breakpoint
CREATE TABLE `share_view` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`link_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`ip_address` text,
	`user_agent` text,
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`link_id`) REFERENCES `share_link`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `share_view_link_idx` ON `share_view` (`link_id`,`created_at`);