/*
  Warnings:

  - The values [existing,new] on the enum `OnboardedType` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the `Company` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `CompanyHistory` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `CompanyMapping` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `CompanyOnboarding` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `GroupCompany` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `OrgHistory` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `OrgStructure` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `OrgStructureReq` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Roles` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `User` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `UserAccess` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `UserActivity` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `UserHistory` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `UserMapping` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `UserOnboarding` table. If the table is not empty, all the data it contains will be lost.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "OnboardedType_new" AS ENUM ('EXISTING', 'NEW');
ALTER TABLE "CompanyOnboarding" ALTER COLUMN "onboardedType" DROP DEFAULT;
ALTER TABLE "CompanyOnboarding" ALTER COLUMN "onboardedType" TYPE "OnboardedType_new" USING ("onboardedType"::text::"OnboardedType_new");
ALTER TYPE "OnboardedType" RENAME TO "OnboardedType_old";
ALTER TYPE "OnboardedType_new" RENAME TO "OnboardedType";
DROP TYPE "OnboardedType_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "CompanyHistory" DROP CONSTRAINT "CompanyHistory_eventUserId_fkey";

-- DropForeignKey
ALTER TABLE "CompanyMapping" DROP CONSTRAINT "CompanyMapping_companyId_fkey";

-- DropForeignKey
ALTER TABLE "CompanyMapping" DROP CONSTRAINT "CompanyMapping_groupId_fkey";

-- DropForeignKey
ALTER TABLE "OrgHistory" DROP CONSTRAINT "OrgHistory_eventUserId_fkey";

-- DropForeignKey
ALTER TABLE "OrgHistory" DROP CONSTRAINT "OrgHistory_orgReqId_fkey";

-- DropForeignKey
ALTER TABLE "OrgStructure" DROP CONSTRAINT "OrgStructure_companyId_fkey";

-- DropForeignKey
ALTER TABLE "OrgStructure" DROP CONSTRAINT "OrgStructure_parentId_fkey";

-- DropForeignKey
ALTER TABLE "OrgStructureReq" DROP CONSTRAINT "OrgStructureReq_companyId_fkey";

-- DropForeignKey
ALTER TABLE "UserAccess" DROP CONSTRAINT "UserAccess_companyId_fkey";

-- DropForeignKey
ALTER TABLE "UserAccess" DROP CONSTRAINT "UserAccess_nodeId_fkey";

-- DropForeignKey
ALTER TABLE "UserAccess" DROP CONSTRAINT "UserAccess_roleCode_fkey";

-- DropForeignKey
ALTER TABLE "UserAccess" DROP CONSTRAINT "UserAccess_userId_fkey";

-- DropForeignKey
ALTER TABLE "UserActivity" DROP CONSTRAINT "UserActivity_userId_fkey";

-- DropForeignKey
ALTER TABLE "UserHistory" DROP CONSTRAINT "UserHistory_eventUserId_fkey";

-- DropForeignKey
ALTER TABLE "UserMapping" DROP CONSTRAINT "UserMapping_companyId_fkey";

-- DropForeignKey
ALTER TABLE "UserMapping" DROP CONSTRAINT "UserMapping_reportingManager_fkey";

-- DropForeignKey
ALTER TABLE "UserMapping" DROP CONSTRAINT "UserMapping_userId_fkey";

-- DropTable
DROP TABLE "Company";

-- DropTable
DROP TABLE "CompanyHistory";

-- DropTable
DROP TABLE "CompanyMapping";

-- DropTable
DROP TABLE "CompanyOnboarding";

-- DropTable
DROP TABLE "GroupCompany";

-- DropTable
DROP TABLE "OrgHistory";

-- DropTable
DROP TABLE "OrgStructure";

-- DropTable
DROP TABLE "OrgStructureReq";

-- DropTable
DROP TABLE "Roles";

-- DropTable
DROP TABLE "User";

-- DropTable
DROP TABLE "UserAccess";

-- DropTable
DROP TABLE "UserActivity";

-- DropTable
DROP TABLE "UserHistory";

-- DropTable
DROP TABLE "UserMapping";

-- DropTable
DROP TABLE "UserOnboarding";

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company" (
    "id" TEXT NOT NULL,
    "gst_number" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "status" "Status" NOT NULL,
    "registration_date" TIMESTAMP(3) NOT NULL,
    "brand_name" TEXT NOT NULL,
    "iecode" TEXT NOT NULL,
    "company_code" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "Status" NOT NULL,
    "group_code" TEXT NOT NULL,
    "remarks" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_history" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "company_code" TEXT NOT NULL,
    "event" "EventType" NOT NULL,
    "event_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_history" (
    "id" TEXT NOT NULL,
    "company_code" TEXT NOT NULL,
    "event" "EventType" NOT NULL,
    "event_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_mapping" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "reporting_manager" TEXT,
    "status" "Status" NOT NULL,
    "designation" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_mapping" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_activity" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "refresh_token" TEXT,
    "version" TEXT,
    "ip_address" TEXT NOT NULL,
    "user_agent" TEXT NOT NULL,
    "force_log_token" TEXT,
    "expiry_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_onboarding" (
    "id" TEXT NOT NULL,
    "group_code" TEXT,
    "company_code" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "status" "OnboardingStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "approval_remark" TEXT,
    "accessible_by" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "user_onboarding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_onboarding" (
    "id" TEXT NOT NULL,
    "data" JSONB,
    "group_code" TEXT,
    "company_code" TEXT NOT NULL,
    "onboarded_type" "OnboardedType" NOT NULL DEFAULT 'NEW',
    "status" "OnboardingStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "approval_remark" TEXT,
    "accessible_by" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "company_onboarding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_structure_req" (
    "id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "company_id" TEXT NOT NULL,
    "status" "OnboardingStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "remarks" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "accessible_by" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "org_structure_req_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_history" (
    "id" TEXT NOT NULL,
    "org_req_id" TEXT NOT NULL,
    "company_code" TEXT NOT NULL,
    "event" "EventType" NOT NULL,
    "event_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_structure" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "node_path" TEXT NOT NULL,
    "node_name" TEXT NOT NULL,
    "node_type" "NodeType" NOT NULL,
    "parent_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_structure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "role_code" TEXT NOT NULL,
    "role_name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "sub_category" TEXT NOT NULL,
    "permission_level" TEXT,
    "view" BOOLEAN NOT NULL DEFAULT false,
    "modify" BOOLEAN NOT NULL DEFAULT false,
    "approve" BOOLEAN NOT NULL DEFAULT false,
    "initiate" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("role_code")
);

-- CreateTable
CREATE TABLE "user_access" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role_code" TEXT,
    "node_id" TEXT NOT NULL,
    "access_type" TEXT,
    "company_id" TEXT NOT NULL,
    "is_global_access" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_access_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "company_gst_number_key" ON "company"("gst_number");

-- CreateIndex
CREATE UNIQUE INDEX "company_iecode_key" ON "company"("iecode");

-- CreateIndex
CREATE UNIQUE INDEX "company_company_code_key" ON "company"("company_code");

-- CreateIndex
CREATE UNIQUE INDEX "group_company_group_code_key" ON "group_company"("group_code");

-- CreateIndex
CREATE UNIQUE INDEX "company_onboarding_company_code_key" ON "company_onboarding"("company_code");

-- CreateIndex
CREATE UNIQUE INDEX "org_structure_node_path_key" ON "org_structure"("node_path");

-- CreateIndex
CREATE UNIQUE INDEX "roles_role_name_key" ON "roles"("role_name");

-- AddForeignKey
ALTER TABLE "user_history" ADD CONSTRAINT "user_history_event_user_id_fkey" FOREIGN KEY ("event_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_history" ADD CONSTRAINT "company_history_event_user_id_fkey" FOREIGN KEY ("event_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_mapping" ADD CONSTRAINT "user_mapping_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_mapping" ADD CONSTRAINT "user_mapping_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_mapping" ADD CONSTRAINT "user_mapping_reporting_manager_fkey" FOREIGN KEY ("reporting_manager") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_mapping" ADD CONSTRAINT "company_mapping_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_mapping" ADD CONSTRAINT "company_mapping_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "group_company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_activity" ADD CONSTRAINT "user_activity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_structure_req" ADD CONSTRAINT "org_structure_req_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_history" ADD CONSTRAINT "org_history_event_user_id_fkey" FOREIGN KEY ("event_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_history" ADD CONSTRAINT "org_history_org_req_id_fkey" FOREIGN KEY ("org_req_id") REFERENCES "org_structure_req"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_structure" ADD CONSTRAINT "org_structure_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_structure" ADD CONSTRAINT "org_structure_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "org_structure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_access" ADD CONSTRAINT "user_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_access" ADD CONSTRAINT "user_access_role_code_fkey" FOREIGN KEY ("role_code") REFERENCES "roles"("role_code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_access" ADD CONSTRAINT "user_access_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "org_structure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_access" ADD CONSTRAINT "user_access_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
