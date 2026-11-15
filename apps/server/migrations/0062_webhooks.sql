CREATE TABLE `webhook` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`url_sealed` text NOT NULL,
	`host` text NOT NULL,
	`events` text NOT NULL,
	`secret_sealed` text NOT NULL,
	`previous_secret_sealed` text,
	`previous_secret_until` integer,
	`allow_local` integer DEFAULT false NOT NULL,
	`paused_at` integer,
	`disabled_at` integer,
	`failures` integer DEFAULT 0 NOT NULL,
	`last_delivery_at` integer,
	`last_status` integer,
	`last_error` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `webhook_household_idx` ON `webhook` (`household_id`);--> statement-breakpoint
CREATE TABLE `webhook_delivery` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`webhook_id` text NOT NULL,
	`event_id` text NOT NULL,
	`event` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`response_status` integer,
	`error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_attempt_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`webhook_id`) REFERENCES `webhook`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webhook_delivery_webhook_idx` ON `webhook_delivery` (`webhook_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `webhook_delivery_created_idx` ON `webhook_delivery` (`created_at`);--> statement-breakpoint
CREATE TABLE `webhook_sent` (
	`household_id` text NOT NULL,
	`key` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`household_id`, `key`),
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
