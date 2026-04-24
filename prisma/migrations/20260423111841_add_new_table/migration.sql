-- CreateTable
CREATE TABLE "org_structure_req" (
    "id" TEXT NOT NULL,
    "initiator_id" TEXT NOT NULL,
    "approver_id" TEXT,
    "data" JSONB NOT NULL,
    "company_id" TEXT NOT NULL,
    "status" "OnboardingStatus" NOT NULL DEFAULT 'pending',
    "approved_at" TIMESTAMP(3),
    "create_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "remarks" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_structure_req_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_structure" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "nodepath" TEXT NOT NULL,
    "nodename" TEXT NOT NULL,
    "nodetype" TEXT NOT NULL,
    "parent_id" TEXT,
    "create_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

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
    "isactive" BOOLEAN NOT NULL DEFAULT true,
    "create_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("role_code")
);

-- CreateTable
CREATE TABLE "user_access" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role_code" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "access_type" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "isglobalAccess" BOOLEAN NOT NULL DEFAULT false,
    "create_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_access_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "org_structure_nodepath_key" ON "org_structure"("nodepath");

-- CreateIndex
CREATE UNIQUE INDEX "roles_role_name_key" ON "roles"("role_name");

-- AddForeignKey
ALTER TABLE "org_structure_req" ADD CONSTRAINT "org_structure_req_initiator_id_fkey" FOREIGN KEY ("initiator_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_structure_req" ADD CONSTRAINT "org_structure_req_approver_id_fkey" FOREIGN KEY ("approver_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_structure_req" ADD CONSTRAINT "org_structure_req_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_structure" ADD CONSTRAINT "org_structure_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_structure" ADD CONSTRAINT "org_structure_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "org_structure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_access" ADD CONSTRAINT "user_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_access" ADD CONSTRAINT "user_access_role_code_fkey" FOREIGN KEY ("role_code") REFERENCES "roles"("role_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_access" ADD CONSTRAINT "user_access_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "org_structure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_access" ADD CONSTRAINT "user_access_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
