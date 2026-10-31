CREATE TABLE `plan_usage` (
	`household_id` text NOT NULL,
	`period` text NOT NULL,
	`user_id` text DEFAULT '' NOT NULL,
	`kind` text NOT NULL,
	`units` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`household_id`, `period`, `user_id`, `kind`),
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `household_setting` ADD `last_active_on` text;