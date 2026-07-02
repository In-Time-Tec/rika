CREATE TABLE `orbs` (
	`orb_id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`project_id` text NOT NULL,
	`sandbox_id` text NOT NULL,
	`status` text NOT NULL,
	`base_commit` text NOT NULL,
	`endpoint_url` text NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_active_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orbs_thread_idx` ON `orbs` (`thread_id`);--> statement-breakpoint
CREATE INDEX `orbs_project_idx` ON `orbs` (`project_id`);--> statement-breakpoint
CREATE INDEX `orbs_status_idx` ON `orbs` (`status`);