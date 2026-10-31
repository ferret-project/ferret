CREATE TABLE `recall_brand` (
	`brand` text PRIMARY KEY NOT NULL,
	`checked_at` integer NOT NULL,
	`found` integer DEFAULT 0 NOT NULL
);
