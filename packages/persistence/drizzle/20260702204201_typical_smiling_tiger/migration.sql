CREATE TABLE `thread_memory_chunks` (
	`id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`text` text NOT NULL,
	`embedding` blob NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_memory_chunks_thread_turn_idx` ON `thread_memory_chunks` (`thread_id`,`turn_id`);--> statement-breakpoint
CREATE INDEX `thread_memory_chunks_workspace_created_idx` ON `thread_memory_chunks` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `thread_memory_chunks_thread_created_idx` ON `thread_memory_chunks` (`thread_id`,`created_at`);