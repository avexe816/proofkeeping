ALTER TABLE `daily_property_rollup` ADD `inspected_tasks` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `daily_property_rollup` ADD `first_pass_tasks` integer DEFAULT 0 NOT NULL;