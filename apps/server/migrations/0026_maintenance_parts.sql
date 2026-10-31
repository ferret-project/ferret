ALTER TABLE `maintenance_task` ADD `part_item_id` text REFERENCES item(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `maintenance_task` ADD `part_quantity` integer DEFAULT 1 NOT NULL;