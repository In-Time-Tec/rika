CREATE TABLE `thread_files` (
	`thread_id` text NOT NULL,
	`path` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_files_thread_path_idx` ON `thread_files` (`thread_id`,`path`);--> statement-breakpoint
CREATE INDEX `thread_files_path_idx` ON `thread_files` (`path`);--> statement-breakpoint
CREATE INDEX `thread_files_thread_idx` ON `thread_files` (`thread_id`);