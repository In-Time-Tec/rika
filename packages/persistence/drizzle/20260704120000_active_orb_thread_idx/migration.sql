DROP INDEX `orbs_thread_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `orbs_thread_idx` ON `orbs` (`thread_id`) WHERE `status` in ('provisioning', 'running', 'paused');
