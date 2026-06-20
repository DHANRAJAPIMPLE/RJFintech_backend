CREATE TABLE "user_workflow_preference" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_workflow_preference_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_workflow_preference_history" (
    "id" TEXT NOT NULL,
    "preference_id" TEXT,
    "company_id" TEXT NOT NULL,
    "event_user_id" TEXT NOT NULL,
    "old_data" JSONB,
    "new_data" JSONB,
    "remarks" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_workflow_preference_history_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_workflow_preference_user_id_module_node_id_key"
ON "user_workflow_preference"("user_id", "module", "node_id");

CREATE INDEX "user_workflow_preference_company_id_idx"
ON "user_workflow_preference"("company_id");

CREATE INDEX "user_workflow_preference_user_id_idx"
ON "user_workflow_preference"("user_id");

CREATE INDEX "user_workflow_preference_module_idx"
ON "user_workflow_preference"("module");

CREATE INDEX "user_workflow_preference_node_id_idx"
ON "user_workflow_preference"("node_id");

CREATE INDEX "user_workflow_preference_workflow_id_idx"
ON "user_workflow_preference"("workflow_id");

CREATE INDEX "user_workflow_preference_history_preference_id_idx"
ON "user_workflow_preference_history"("preference_id");

CREATE INDEX "user_workflow_preference_history_company_id_idx"
ON "user_workflow_preference_history"("company_id");

CREATE INDEX "user_workflow_preference_history_event_user_id_idx"
ON "user_workflow_preference_history"("event_user_id");

ALTER TABLE "user_workflow_preference"
ADD CONSTRAINT "user_workflow_preference_company_id_fkey"
FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "user_workflow_preference"
ADD CONSTRAINT "user_workflow_preference_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "user_workflow_preference"
ADD CONSTRAINT "user_workflow_preference_node_id_fkey"
FOREIGN KEY ("node_id") REFERENCES "org_structure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "user_workflow_preference"
ADD CONSTRAINT "user_workflow_preference_workflow_id_fkey"
FOREIGN KEY ("workflow_id") REFERENCES "workflow"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "user_workflow_preference_history"
ADD CONSTRAINT "user_workflow_preference_history_preference_id_fkey"
FOREIGN KEY ("preference_id") REFERENCES "user_workflow_preference"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "user_workflow_preference_history"
ADD CONSTRAINT "user_workflow_preference_history_company_id_fkey"
FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "user_workflow_preference_history"
ADD CONSTRAINT "user_workflow_preference_history_event_user_id_fkey"
FOREIGN KEY ("event_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
