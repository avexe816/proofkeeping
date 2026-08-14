CREATE TABLE `billing_period_review` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`billing_period_id` text NOT NULL,
	`seq` integer NOT NULL,
	`action` text NOT NULL,
	`comment` text,
	`line_comments` text DEFAULT '[]' NOT NULL,
	`lines_snapshot` text DEFAULT '[]' NOT NULL,
	`snapshot_total_amount` integer DEFAULT 0 NOT NULL,
	`status_before` text NOT NULL,
	`status_after` text NOT NULL,
	`by_counterparty` integer DEFAULT false NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_bprv_seq` ON `billing_period_review` (`organization_id`,`billing_period_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_bprv_period` ON `billing_period_review` (`organization_id`,`billing_period_id`);