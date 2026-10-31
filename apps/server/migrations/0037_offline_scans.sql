ALTER TABLE `stock_movement` ADD `client_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `stock_movement_client_idx` ON `stock_movement` (`household_id`,`client_id`);