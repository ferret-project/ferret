CREATE TABLE `barcode_product` (
	`barcode` text PRIMARY KEY NOT NULL,
	`name` text,
	`brand` text,
	`model` text,
	`source` text,
	`external` text,
	`not_found_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `item` ADD `product_dismissed_for` text;