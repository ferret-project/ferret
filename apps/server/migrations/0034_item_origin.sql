ALTER TABLE `item` ADD `origin` text;--> statement-breakpoint
ALTER TABLE `item` ADD `origin_detail` text;--> statement-breakpoint
UPDATE `item` SET `origin` = CASE (SELECT `source` FROM `import_batch` WHERE `import_batch`.`id` = `item`.`import_batch_id`) WHEN 'homeassistant' THEN 'homeassistant' ELSE 'spreadsheet' END, `origin_detail` = (SELECT `name` FROM `import_batch` WHERE `import_batch`.`id` = `item`.`import_batch_id`) WHERE `import_batch_id` IS NOT NULL;--> statement-breakpoint
UPDATE `item` SET `origin` = 'homeassistant', `origin_detail` = 'Home Assistant' WHERE `origin` IS NULL AND `ha_device_id` IS NOT NULL;--> statement-breakpoint
UPDATE `item` SET `origin` = COALESCE((SELECT CASE `via` WHEN 'mcp' THEN 'claude' WHEN 'api' THEN 'api' ELSE 'app' END FROM `activity` WHERE `activity`.`action` = 'item.create' AND `activity`.`entity_id` = `item`.`id` LIMIT 1), 'app') WHERE `origin` IS NULL;
