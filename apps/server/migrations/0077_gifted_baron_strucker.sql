CREATE TABLE `item_view` (
	`household_id` text NOT NULL,
	`user_id` text NOT NULL,
	`item_id` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `item_id`),
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `item`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `item_view_person_idx` ON `item_view` (`household_id`,`user_id`,`at`);