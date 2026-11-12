ALTER TABLE `household_setting` ADD `amazon_site` text;--> statement-breakpoint
ALTER TABLE `item` ADD `part_of_item_id` text REFERENCES item(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `item_part_of_idx` ON `item` (`part_of_item_id`);