/*
  Warnings:

  - The values [APPROVE,REJECT] on the enum `EventType` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "EventType_new" AS ENUM ('INITIATE', 'APPROVED', 'REJECTED', 'MODIFY');
ALTER TABLE "UserHistory" ALTER COLUMN "event" TYPE "EventType_new" USING ("event"::text::"EventType_new");
ALTER TABLE "CompanyHistory" ALTER COLUMN "event" TYPE "EventType_new" USING ("event"::text::"EventType_new");
ALTER TABLE "OrgHistory" ALTER COLUMN "event" TYPE "EventType_new" USING ("event"::text::"EventType_new");
ALTER TYPE "EventType" RENAME TO "EventType_old";
ALTER TYPE "EventType_new" RENAME TO "EventType";
DROP TYPE "EventType_old";
COMMIT;

-- AlterTable
ALTER TABLE "Company" ALTER COLUMN "registrationDate" DROP DEFAULT;
