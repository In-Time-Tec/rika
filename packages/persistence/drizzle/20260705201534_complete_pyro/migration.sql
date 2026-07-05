ALTER TABLE `artifacts` ADD `workspace_id` text;--> statement-breakpoint
CREATE INDEX `artifacts_workspace_kind_created_idx` ON `artifacts` (`workspace_id`,`kind`,`created_at`);