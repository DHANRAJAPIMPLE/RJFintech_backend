/*
  Warnings:

  - Added the required column `companyCode` to the `UserHistory` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "UserHistory" ADD COLUMN     "companyCode" TEXT NOT NULL;
