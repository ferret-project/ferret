CREATE TABLE `paperless_connection` (
	`household_id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`token_sealed` text NOT NULL,
	`tag` text NOT NULL,
	`tag_id` integer,
	`copy_files` integer DEFAULT true NOT NULL,
	`allow_local` integer DEFAULT false NOT NULL,
	`remote_user` text,
	`last_sync_at` integer,
	`last_error` text,
	`failing_since` integer,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `paperless_document` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`paperless_id` integer NOT NULL,
	`title` text NOT NULL,
	`correspondent` text,
	`created` text,
	`excerpt` text DEFAULT '' NOT NULL,
	`mime_type` text,
	`status` text DEFAULT 'new' NOT NULL,
	`item_id` text,
	`attachment_id` text,
	`handled_by` text,
	`handled_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `item`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachment`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`handled_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `paperless_document_household_doc` ON `paperless_document` (`household_id`,`paperless_id`);--> statement-breakpoint
CREATE INDEX `paperless_document_status_idx` ON `paperless_document` (`household_id`,`status`);