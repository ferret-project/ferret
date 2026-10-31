CREATE TABLE `household_setting` (
	`household_id` text PRIMARY KEY NOT NULL,
	`time_zone` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
