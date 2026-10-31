CREATE TABLE `job` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`run_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `job_due_idx` ON `job` (`status`,`run_at`);--> statement-breakpoint
ALTER TABLE `attachment` ADD `analysis_status` text;--> statement-breakpoint
ALTER TABLE `attachment` ADD `analysis` text;--> statement-breakpoint
ALTER TABLE `attachment` ADD `analyzed_at` integer;--> statement-breakpoint
ALTER TABLE `attachment` ADD `suggestions_dismissed_at` integer;