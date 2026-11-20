CREATE TABLE `card_info` (
	`key` text PRIMARY KEY NOT NULL,
	`info` text NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `item` ADD `card` text;