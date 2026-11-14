-- Files can belong to a property, a place or a maintenance task as well as a thing: attachment.item_id may be null,
-- and exactly one owner is set (the check). SQLite can't relax NOT NULL in place, so the table is rebuilt.
-- Migrations run in a transaction (and on D1 foreign keys can't be turned off), so dropping the old table runs the
-- "on delete set null" of the tables pointing at it: their links are kept aside first and put back afterwards.
CREATE TABLE `__attachment_links` (`tbl` text NOT NULL, `row_id` text NOT NULL, `attachment_id` text NOT NULL);
--> statement-breakpoint
INSERT INTO `__attachment_links` SELECT 'warranty', `id`, `attachment_id` FROM `warranty` WHERE `attachment_id` IS NOT NULL;
--> statement-breakpoint
INSERT INTO `__attachment_links` SELECT 'maintenance_task', `id`, `attachment_id` FROM `maintenance_task` WHERE `attachment_id` IS NOT NULL;
--> statement-breakpoint
INSERT INTO `__attachment_links` SELECT 'suggested_task', `id`, `attachment_id` FROM `suggested_task` WHERE `attachment_id` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `__new_attachment` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`item_id` text,
	`property_id` text,
	`location_id` text,
	`task_id` text,
	`kind` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`blob_key` text NOT NULL,
	`thumbnail_key` text,
	`analysis_status` text,
	`analysis` text,
	`analyzed_at` integer,
	`suggestions_dismissed_at` integer,
	`original_removed_at` integer,
	`main_at` integer,
	`repair_id` text,
	`done_id` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `item`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`property_id`) REFERENCES `property`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`location_id`) REFERENCES `location`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `maintenance_task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repair_id`) REFERENCES `repair`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`done_id`) REFERENCES `maintenance_log`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "attachment_one_owner" CHECK(("item_id" is not null) + ("property_id" is not null) + ("location_id" is not null) + ("task_id" is not null) = 1)
);
--> statement-breakpoint
INSERT INTO `__new_attachment`("id", "household_id", "item_id", "kind", "filename", "content_type", "size", "blob_key", "thumbnail_key", "analysis_status", "analysis", "analyzed_at", "suggestions_dismissed_at", "original_removed_at", "main_at", "repair_id", "created_by", "created_at", "updated_at", "deleted_at") SELECT "id", "household_id", "item_id", "kind", "filename", "content_type", "size", "blob_key", "thumbnail_key", "analysis_status", "analysis", "analyzed_at", "suggestions_dismissed_at", "original_removed_at", "main_at", "repair_id", "created_by", "created_at", "updated_at", "deleted_at" FROM `attachment`;
--> statement-breakpoint
DROP TABLE `attachment`;
--> statement-breakpoint
ALTER TABLE `__new_attachment` RENAME TO `attachment`;
--> statement-breakpoint
CREATE INDEX `attachment_item_idx` ON `attachment` (`household_id`,`item_id`);
--> statement-breakpoint
CREATE INDEX `attachment_property_idx` ON `attachment` (`household_id`,`property_id`);
--> statement-breakpoint
CREATE INDEX `attachment_location_idx` ON `attachment` (`household_id`,`location_id`);
--> statement-breakpoint
CREATE INDEX `attachment_task_idx` ON `attachment` (`household_id`,`task_id`);
--> statement-breakpoint
UPDATE `warranty` SET `attachment_id` = (SELECT l.`attachment_id` FROM `__attachment_links` l WHERE l.`tbl` = 'warranty' AND l.`row_id` = `warranty`.`id`) WHERE `id` IN (SELECT `row_id` FROM `__attachment_links` WHERE `tbl` = 'warranty');
--> statement-breakpoint
UPDATE `maintenance_task` SET `attachment_id` = (SELECT l.`attachment_id` FROM `__attachment_links` l WHERE l.`tbl` = 'maintenance_task' AND l.`row_id` = `maintenance_task`.`id`) WHERE `id` IN (SELECT `row_id` FROM `__attachment_links` WHERE `tbl` = 'maintenance_task');
--> statement-breakpoint
UPDATE `suggested_task` SET `attachment_id` = (SELECT l.`attachment_id` FROM `__attachment_links` l WHERE l.`tbl` = 'suggested_task' AND l.`row_id` = `suggested_task`.`id`) WHERE `id` IN (SELECT `row_id` FROM `__attachment_links` WHERE `tbl` = 'suggested_task');
--> statement-breakpoint
DROP TABLE `__attachment_links`;
