CREATE TABLE `thread_events` (
	`id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`turn_id` text,
	`sequence` integer NOT NULL,
	`version` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`message_id` text,
	`tool_call_id` text,
	`artifact_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_events_thread_sequence_idx` ON `thread_events` (`thread_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `thread_events_thread_created_idx` ON `thread_events` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `thread_events_type_idx` ON `thread_events` (`type`);