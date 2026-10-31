CREATE TABLE `household_barcode` (
	`household_id` text NOT NULL,
	`barcode` text NOT NULL,
	`name` text NOT NULL,
	`brand` text,
	`model` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`household_id`, `barcode`),
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- The shared barcode book keeps only what the online database says: names people gave their items move out of it
-- (they're relearned per household as items are saved). Where the online database answered, its title stands in.
UPDATE `barcode_product` SET
	`name` = json_extract(`external`, '$.title'),
	`brand` = json_extract(`external`, '$.brand'),
	`model` = json_extract(`external`, '$.model'),
	`source` = 'upcitemdb'
WHERE `source` = 'ferret' AND `external` IS NOT NULL;
--> statement-breakpoint
DELETE FROM `barcode_product` WHERE `source` = 'ferret';
--> statement-breakpoint
-- Email addresses must now be verified before signing in (after the first account). Accounts made before that
-- signed in without it: they stay able to.
UPDATE `user` SET `email_verified` = 1 WHERE `email_verified` = 0;
