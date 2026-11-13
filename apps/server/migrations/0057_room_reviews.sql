CREATE TABLE `room_review` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`location_id` text NOT NULL,
	`started_by` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`location_id`) REFERENCES `location`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`started_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `room_review_location_idx` ON `room_review` (`household_id`,`location_id`,`finished_at`);--> statement-breakpoint
CREATE TABLE `room_review_entry` (
	`household_id` text NOT NULL,
	`review_id` text NOT NULL,
	`item_id` text NOT NULL,
	`outcome` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`review_id`, `item_id`),
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_id`) REFERENCES `room_review`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `item`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `item` ADD `missing_since` integer;