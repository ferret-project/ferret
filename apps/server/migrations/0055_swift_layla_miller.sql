CREATE TABLE `household_language` (
	`household_id` text PRIMARY KEY NOT NULL,
	`language` text DEFAULT 'en' NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_language` (
	`user_id` text PRIMARY KEY NOT NULL,
	`language` text DEFAULT 'en' NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
