CREATE TABLE `service_error` (
	`id` text PRIMARY KEY NOT NULL,
	`service` text NOT NULL,
	`operation` text NOT NULL,
	`message` text NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`first_at` integer NOT NULL,
	`last_at` integer NOT NULL,
	`notified_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_error_key_idx` ON `service_error` (`service`,`operation`,`message`);--> statement-breakpoint
CREATE INDEX `service_error_last_idx` ON `service_error` (`last_at`);