CREATE TABLE `invitation_email` (
	`invitation_id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`queued_at` integer NOT NULL,
	`sent_at` integer,
	`error` text,
	FOREIGN KEY (`invitation_id`) REFERENCES `invitation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `invitation_email_household_idx` ON `invitation_email` (`household_id`,`sent_at`);