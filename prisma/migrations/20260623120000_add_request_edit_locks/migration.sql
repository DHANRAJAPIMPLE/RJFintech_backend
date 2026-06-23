ALTER TABLE "user_onboarding"
ADD COLUMN "edit_locked_by" TEXT,
ADD COLUMN "edit_locked_at" TIMESTAMP(3),
ADD COLUMN "edit_lock_expires_at" TIMESTAMP(3);

ALTER TABLE "org_structure_req"
ADD COLUMN "edit_locked_by" TEXT,
ADD COLUMN "edit_locked_at" TIMESTAMP(3),
ADD COLUMN "edit_lock_expires_at" TIMESTAMP(3);

ALTER TABLE "workflow_req"
ADD COLUMN "edit_locked_by" TEXT,
ADD COLUMN "edit_locked_at" TIMESTAMP(3),
ADD COLUMN "edit_lock_expires_at" TIMESTAMP(3);
