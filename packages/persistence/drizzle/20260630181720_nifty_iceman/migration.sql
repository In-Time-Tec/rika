ALTER TABLE `thread_projections` ADD `title_text` text;--> statement-breakpoint
ALTER TABLE `thread_projections` ADD `diff_additions` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `thread_projections` ADD `diff_modifications` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `thread_projections` ADD `diff_deletions` integer DEFAULT 0 NOT NULL;