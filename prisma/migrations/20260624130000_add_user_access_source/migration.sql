-- CreateEnum
CREATE TYPE "AccessSource" AS ENUM ('USER', 'AUTO_GENERATED');

-- AlterTable
ALTER TABLE "user_access" ADD COLUMN "source" "AccessSource" NOT NULL DEFAULT 'USER';
