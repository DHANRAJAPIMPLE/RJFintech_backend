-- CreateEnum
CREATE TYPE "NodeType" AS ENUM ('ROOT', 'DEPARTMENT', 'TEAM', 'PLANT', 'LOCATION');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('INITIATE', 'APPROVE', 'REJECT', 'MODIFY');

-- CreateEnum
CREATE TYPE "Status" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "OnboardingStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "OnboardedType" AS ENUM ('existing', 'new');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "gstNumber" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "status" "Status" NOT NULL,
    "registrationDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "brandName" TEXT NOT NULL,
    "iecode" TEXT NOT NULL,
    "companyCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupCompany" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "Status" NOT NULL,
    "groupCode" TEXT NOT NULL,
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupCompany_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserHistory" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "event" "EventType" NOT NULL,
    "eventUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyHistory" (
    "id" TEXT NOT NULL,
    "companyCode" TEXT NOT NULL,
    "event" "EventType" NOT NULL,
    "eventUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserMapping" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "reportingManager" TEXT,
    "status" "Status" NOT NULL,
    "designation" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyMapping" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserActivity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshToken" TEXT,
    "version" TEXT,
    "ipAddress" TEXT NOT NULL,
    "userAgent" TEXT NOT NULL,
    "forceLogToken" TEXT,
    "expiryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserOnboarding" (
    "id" TEXT NOT NULL,
    "groupCode" TEXT,
    "companyCode" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "status" "OnboardingStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "approvalRemark" TEXT,
    "accessibleBy" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "UserOnboarding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyOnboarding" (
    "id" TEXT NOT NULL,
    "data" JSONB,
    "groupCode" TEXT,
    "companyCode" TEXT NOT NULL,
    "onboardedType" "OnboardedType" NOT NULL DEFAULT 'new',
    "status" "OnboardingStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "approvalRemark" TEXT,
    "accessibleBy" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "CompanyOnboarding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgStructureReq" (
    "id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "companyId" TEXT NOT NULL,
    "status" "OnboardingStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "remarks" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "accessibleBy" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "OrgStructureReq_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgHistory" (
    "id" TEXT NOT NULL,
    "orgReqId" TEXT NOT NULL,
    "companyCode" TEXT NOT NULL,
    "event" "EventType" NOT NULL,
    "eventUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgStructure" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "nodePath" TEXT NOT NULL,
    "nodeName" TEXT NOT NULL,
    "nodeType" "NodeType" NOT NULL,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgStructure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Roles" (
    "roleCode" TEXT NOT NULL,
    "roleName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subCategory" TEXT NOT NULL,
    "permissionLevel" TEXT,
    "view" BOOLEAN NOT NULL DEFAULT false,
    "modify" BOOLEAN NOT NULL DEFAULT false,
    "approve" BOOLEAN NOT NULL DEFAULT false,
    "initiate" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Roles_pkey" PRIMARY KEY ("roleCode")
);

-- CreateTable
CREATE TABLE "UserAccess" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleCode" TEXT,
    "nodeId" TEXT NOT NULL,
    "accessType" TEXT,
    "companyId" TEXT NOT NULL,
    "isGlobalAccess" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Company_gstNumber_key" ON "Company"("gstNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Company_iecode_key" ON "Company"("iecode");

-- CreateIndex
CREATE UNIQUE INDEX "Company_companyCode_key" ON "Company"("companyCode");

-- CreateIndex
CREATE UNIQUE INDEX "GroupCompany_groupCode_key" ON "GroupCompany"("groupCode");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyOnboarding_companyCode_key" ON "CompanyOnboarding"("companyCode");

-- CreateIndex
CREATE UNIQUE INDEX "OrgStructure_nodePath_key" ON "OrgStructure"("nodePath");

-- CreateIndex
CREATE UNIQUE INDEX "Roles_roleName_key" ON "Roles"("roleName");

-- AddForeignKey
ALTER TABLE "UserHistory" ADD CONSTRAINT "UserHistory_eventUserId_fkey" FOREIGN KEY ("eventUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyHistory" ADD CONSTRAINT "CompanyHistory_eventUserId_fkey" FOREIGN KEY ("eventUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserMapping" ADD CONSTRAINT "UserMapping_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserMapping" ADD CONSTRAINT "UserMapping_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserMapping" ADD CONSTRAINT "UserMapping_reportingManager_fkey" FOREIGN KEY ("reportingManager") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyMapping" ADD CONSTRAINT "CompanyMapping_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyMapping" ADD CONSTRAINT "CompanyMapping_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "GroupCompany"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserActivity" ADD CONSTRAINT "UserActivity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgStructureReq" ADD CONSTRAINT "OrgStructureReq_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgHistory" ADD CONSTRAINT "OrgHistory_eventUserId_fkey" FOREIGN KEY ("eventUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgHistory" ADD CONSTRAINT "OrgHistory_orgReqId_fkey" FOREIGN KEY ("orgReqId") REFERENCES "OrgStructureReq"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgStructure" ADD CONSTRAINT "OrgStructure_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgStructure" ADD CONSTRAINT "OrgStructure_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "OrgStructure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserAccess" ADD CONSTRAINT "UserAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserAccess" ADD CONSTRAINT "UserAccess_roleCode_fkey" FOREIGN KEY ("roleCode") REFERENCES "Roles"("roleCode") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserAccess" ADD CONSTRAINT "UserAccess_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "OrgStructure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserAccess" ADD CONSTRAINT "UserAccess_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
