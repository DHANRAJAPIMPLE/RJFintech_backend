CREATE TYPE "NotificationModule" AS ENUM ('USER', 'WORKFLOW', 'ORG');

CREATE TABLE "notification_settings" (
  "id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "node_id" TEXT NOT NULL,
  "module" "NotificationModule" NOT NULL,
  "is_enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notification_setting_history" (
  "id" TEXT NOT NULL,
  "notification_setting_id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "event_user_id" TEXT NOT NULL,
  "old_data" JSONB,
  "new_data" JSONB,
  "remarks" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "notification_setting_history_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_settings_company_id_user_id_node_id_module_key"
  ON "notification_settings"("company_id", "user_id", "node_id", "module");

CREATE INDEX "notification_settings_company_id_idx" ON "notification_settings"("company_id");
CREATE INDEX "notification_settings_user_id_idx" ON "notification_settings"("user_id");
CREATE INDEX "notification_settings_node_id_idx" ON "notification_settings"("node_id");
CREATE INDEX "notification_settings_company_id_user_id_idx" ON "notification_settings"("company_id", "user_id");
CREATE INDEX "notification_settings_company_id_user_id_node_id_idx" ON "notification_settings"("company_id", "user_id", "node_id");

CREATE INDEX "notification_setting_history_notification_setting_id_idx" ON "notification_setting_history"("notification_setting_id");
CREATE INDEX "notification_setting_history_company_id_idx" ON "notification_setting_history"("company_id");
CREATE INDEX "notification_setting_history_event_user_id_idx" ON "notification_setting_history"("event_user_id");

ALTER TABLE "notification_settings"
  ADD CONSTRAINT "notification_settings_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notification_settings"
  ADD CONSTRAINT "notification_settings_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notification_settings"
  ADD CONSTRAINT "notification_settings_node_id_fkey"
  FOREIGN KEY ("node_id") REFERENCES "org_structure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notification_setting_history"
  ADD CONSTRAINT "notification_setting_history_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notification_setting_history"
  ADD CONSTRAINT "notification_setting_history_event_user_id_fkey"
  FOREIGN KEY ("event_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notification_setting_history"
  ADD CONSTRAINT "notification_setting_history_notification_setting_id_fkey"
  FOREIGN KEY ("notification_setting_id") REFERENCES "notification_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
