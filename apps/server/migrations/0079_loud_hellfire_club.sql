CREATE TABLE `app_web_session` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text,
	`token_hash` text,
	`user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`reference_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_client`(`client_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_web_session_code_hash_unique` ON `app_web_session` (`code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `app_web_session_token_hash_unique` ON `app_web_session` (`token_hash`);--> statement-breakpoint
CREATE INDEX `app_web_session_grant_idx` ON `app_web_session` (`client_id`,`user_id`,`reference_id`);