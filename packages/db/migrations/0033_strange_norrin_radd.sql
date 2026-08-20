ALTER TABLE `platform_tenant_snapshot` ADD `findings_high` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `platform_tenant_snapshot` ADD `photo_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `platform_tenant_snapshot` ADD `locale_counts` text DEFAULT '{}' NOT NULL;