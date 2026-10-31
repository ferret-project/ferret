CREATE TABLE `rate_limit` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_limit_key_unique` ON `rate_limit` (`key`);--> statement-breakpoint
CREATE TABLE `sign_in_failure` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`user_id` text,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sign_in_failure_email_idx` ON `sign_in_failure` (`email`,`created_at`);--> statement-breakpoint
CREATE INDEX `sign_in_failure_ip_idx` ON `sign_in_failure` (`ip_address`,`created_at`);--> statement-breakpoint
CREATE TABLE `sign_in_unlock` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sign_in_unlock_token_hash_unique` ON `sign_in_unlock` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sign_in_unlock_email_idx` ON `sign_in_unlock` (`email`,`created_at`);--> statement-breakpoint
CREATE TABLE `spent_challenge` (
	`signature` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
