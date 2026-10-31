ALTER TABLE `activity` ADD `item_id` text;--> statement-breakpoint
CREATE INDEX `activity_item_idx` ON `activity` (`household_id`,`item_id`,`created_at`);--> statement-breakpoint
UPDATE `activity` SET `item_id` = `entity_id` WHERE `entity_type` = 'item';--> statement-breakpoint
UPDATE `activity` SET `item_id` = (SELECT `item_id` FROM `attachment` WHERE `attachment`.`id` = `activity`.`entity_id`) WHERE `entity_type` = 'attachment';--> statement-breakpoint
UPDATE `activity` SET `item_id` = (SELECT `item_id` FROM `warranty` WHERE `warranty`.`id` = `activity`.`entity_id`) WHERE `entity_type` = 'warranty';--> statement-breakpoint
UPDATE `activity` SET `item_id` = (SELECT `w`.`item_id` FROM `warranty_claim` `c` JOIN `warranty` `w` ON `w`.`id` = `c`.`warranty_id` WHERE `c`.`id` = `activity`.`entity_id`) WHERE `entity_type` = 'claim';--> statement-breakpoint
UPDATE `activity` SET `item_id` = (SELECT `item_id` FROM `maintenance_task` WHERE `maintenance_task`.`id` = `activity`.`entity_id`) WHERE `entity_type` = 'maintenance';
