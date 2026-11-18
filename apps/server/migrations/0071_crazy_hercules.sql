CREATE TABLE `account_setting` (
	`user_id` text PRIMARY KEY NOT NULL,
	`language` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
