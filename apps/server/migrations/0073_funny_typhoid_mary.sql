CREATE TABLE `support_product` (
	`name` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`releases` text NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `item` ADD `support` text;--> statement-breakpoint
ALTER TABLE `item` ADD `support_dismissed` text;