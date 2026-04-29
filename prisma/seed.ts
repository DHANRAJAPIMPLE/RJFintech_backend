import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // 1. Seed Roles
  const roles = [
    {
      roleCode: 'ACCOUNTS_VIEWER',
      roleName: 'Accounts Viewer',
      category: 'TRANSACTIONAL',
      subCategory: 'ACCOUNTS',
      permissionLevel: 'VIEWER',
      view: true,
      modify: false,
      approve: false,
      initiate: false,
    },
    {
      roleCode: 'ACCOUNTS_USER',
      roleName: 'Accounts User',
      category: 'TRANSACTIONAL',
      subCategory: 'ACCOUNTS',
      permissionLevel: 'USER',
      view: true,
      modify: true,
      approve: false,
      initiate: true,
    },
    {
      roleCode: 'ACCOUNTS_MGR',
      roleName: 'Accounts Manager',
      category: 'TRANSACTIONAL',
      subCategory: 'ACCOUNTS',
      permissionLevel: 'MANAGER',
      view: true,
      modify: false,
      approve: true,
      initiate: false,
    },
    {
      roleCode: 'PAYMENTS_VIEWER',
      roleName: 'Payments Viewer',
      category: 'TRANSACTIONAL',
      subCategory: 'PAYMENTS',
      permissionLevel: 'VIEWER',
      view: true,
      modify: false,
      approve: false,
      initiate: false,
    },
    {
      roleCode: 'PAYMENTS_USER',
      roleName: 'Payments User',
      category: 'TRANSACTIONAL',
      subCategory: 'PAYMENTS',
      permissionLevel: 'USER',
      view: true,
      modify: true,
      approve: false,
      initiate: true,
    },
    {
      roleCode: 'PAYMENTS_MGR',
      roleName: 'Payments Manager',
      category: 'TRANSACTIONAL',
      subCategory: 'PAYMENTS',
      permissionLevel: 'MANAGER',
      view: true,
      modify: false,
      approve: true,
      initiate: false,
    },
    {
      roleCode: 'PURCHASE_VIEWER',
      roleName: 'Purchase Viewer',
      category: 'TRANSACTIONAL',
      subCategory: 'PURCHASE',
      permissionLevel: 'VIEWER',
      view: true,
      modify: false,
      approve: false,
      initiate: false,
    },
    {
      roleCode: 'PURCHASE_USER',
      roleName: 'Purchase User',
      category: 'TRANSACTIONAL',
      subCategory: 'PURCHASE',
      permissionLevel: 'USER',
      view: true,
      modify: true,
      approve: false,
      initiate: true,
    },
    {
      roleCode: 'PURCHASE_MGR',
      roleName: 'Purchase Manager',
      category: 'TRANSACTIONAL',
      subCategory: 'PURCHASE',
      permissionLevel: 'MANAGER',
      view: true,
      modify: false,
      approve: true,
      initiate: false,
    },
    {
      roleCode: 'FINOPS_VIEWER',
      roleName: 'Fin Ops Viewer',
      category: 'OPERATIONAL',
      subCategory: 'FIN_OPS',
      permissionLevel: 'VIEWER',
      view: true,
      modify: false,
      approve: false,
      initiate: false,
    },
    {
      roleCode: 'FINOPS_USER',
      roleName: 'Fin Ops User',
      category: 'OPERATIONAL',
      subCategory: 'FIN_OPS',
      permissionLevel: 'USER',
      view: true,
      modify: true,
      approve: false,
      initiate: true,
    },
    {
      roleCode: 'FINOPS_MGR',
      roleName: 'Fin Ops Manager',
      category: 'OPERATIONAL',
      subCategory: 'FIN_OPS',
      permissionLevel: 'MANAGER',
      view: true,
      modify: false,
      approve: true,
      initiate: false,
    },
    {
      roleCode: 'MASTER_VIEWER',
      roleName: 'Master Viewer',
      category: 'OPERATIONAL',
      subCategory: 'MASTER',
      permissionLevel: 'VIEWER',
      view: true,
      modify: false,
      approve: false,
      initiate: false,
    },
    {
      roleCode: 'MASTER_USER',
      roleName: 'Master User',
      category: 'OPERATIONAL',
      subCategory: 'MASTER',
      permissionLevel: 'USER',
      view: true,
      modify: true,
      approve: false,
      initiate: true,
    },
    {
      roleCode: 'MASTER_MGR',
      roleName: 'Master Manager',
      category: 'OPERATIONAL',
      subCategory: 'MASTER',
      permissionLevel: 'MANAGER',
      view: true,
      modify: false,
      approve: true,
      initiate: false,
    },
    {
      roleCode: 'ORG_STR_VIEWER',
      roleName: 'Org Structure Viewer',
      category: 'SYSTEM_ACCESS',
      subCategory: 'ORG_STR',
      permissionLevel: 'VIEWER',
      view: true,
      modify: false,
      approve: false,
      initiate: false,
    },
    {
      roleCode: 'ORG_STR_USER',
      roleName: 'Org Structure User',
      category: 'SYSTEM_ACCESS',
      subCategory: 'ORG_STR',
      permissionLevel: 'USER',
      view: true,
      modify: true,
      approve: false,
      initiate: true,
    },
    {
      roleCode: 'ORG_STR_MGR',
      roleName: 'Org Structure Manager',
      category: 'SYSTEM_ACCESS',
      subCategory: 'ORG_STR',
      permissionLevel: 'MANAGER',
      view: true,
      modify: false,
      approve: true,
      initiate: false,
    },
    {
      roleCode: 'USER_ACC_VIEWER',
      roleName: 'User Access Viewer',
      category: 'SYSTEM_ACCESS',
      subCategory: 'USER_ACC',
      permissionLevel: 'VIEWER',
      view: true,
      modify: false,
      approve: false,
      initiate: false,
    },
    {
      roleCode: 'USER_ACC_USER',
      roleName: 'User Access User',
      category: 'SYSTEM_ACCESS',
      subCategory: 'USER_ACC',
      permissionLevel: 'USER',
      view: true,
      modify: true,
      approve: false,
      initiate: true,
    },
    {
      roleCode: 'USER_ACC_MGR',
      roleName: 'User Access Manager',
      category: 'SYSTEM_ACCESS',
      subCategory: 'USER_ACC',
      permissionLevel: 'MANAGER',
      view: true,
      modify: false,
      approve: true,
      initiate: false,
    },
    {
      roleCode: 'WORK_FLOW_VIEWER',
      roleName: 'Workflow Viewer',
      category: 'SYSTEM_ACCESS',
      subCategory: 'WORK_FLOW',
      permissionLevel: 'VIEWER',
      view: true,
      modify: false,
      approve: false,
      initiate: false,
    },
    {
      roleCode: 'WORK_FLOW_USER',
      roleName: 'Workflow User',
      category: 'SYSTEM_ACCESS',
      subCategory: 'WORK_FLOW',
      permissionLevel: 'USER',
      view: true,
      modify: true,
      approve: false,
      initiate: true,
    },
    {
      roleCode: 'WORK_FLOW_MGR',
      roleName: 'Workflow Manager',
      category: 'SYSTEM_ACCESS',
      subCategory: 'WORK_FLOW',
      permissionLevel: 'MANAGER',
      view: true,
      modify: false,
      approve: true,
      initiate: false,
    }
  ];

  for (const role of roles) {
    await prisma.roles.upsert({
      where: { roleCode: role.roleCode },
      update: role,
      create: role,
    });
  }
  console.log('Roles seeded.');

  // 2. Seed Super Admin User
  const adminPassword = await argon2.hash('Admin@123');
  const superAdmin = await prisma.user.upsert({
    where: { email: 'admin@globaltech.com' },
    update: {},
    create: {
      name: 'Super Admin',
      email: 'admin@globaltech.com',
      password: adminPassword,
      phone: '9876543210',
    },
  });
  console.log('Super Admin user created.');

  // 3. Seed Initial Group and Company
  const group = await prisma.groupCompany.upsert({
    where: { groupCode: 'TESTGROUP28042026' },
    update: {},
    create: {
      name: 'TEST Tech Group',
      groupCode: 'TESTGROUP28042026',
      status: 'ACTIVE',
      remarks: 'Primary seeding group',
    },
  });

  const company = await prisma.company.upsert({
    where: { companyCode: 'TEST28042026' },
    update: {},
    create: {
      legalName: 'TEST Tech Solutions Pvt Ltd',
      gstNumber: '27AAAAA0000A1Z5',
      address: '123 Tech Park, Mumbai, Maharashtra',
      brandName: 'TEST Tech',
      iecode: '0123456789',
      companyCode: 'TEST28042026',
      registrationDate: new Date('2023-01-01'),
      status: 'ACTIVE',
    },
  });

  await prisma.companyMapping.upsert({
    where: { id: 'default-mapping' }, // Note: Upsert needs a unique field. id is @id.
    update: {},
    create: {
      id: 'default-mapping',
      companyId: company.id,
      groupId: group.id,
    },
  });
  console.log('Initial Group and Company seeded.');

  // 4. Create Root Org Structure Node
  const rootNode = await prisma.orgStructure.upsert({
    where: { nodePath: 'TEST28042026' },
    update: {},
    create: {
      companyId: company.id,
      nodePath: 'TEST28042026',
      nodeName: 'TEST Tech Solutions Pvt Ltd',
      nodeType: 'ROOT',
    },
  });
  console.log('Root Org Structure node created.');

  // 5. Map Super Admin to Company and give Global Access
  await prisma.userMapping.create({
    data: {
      userId: superAdmin.id,
      companyId: company.id,
      status: 'ACTIVE',
      designation: 'CTO',
      employeeId: 'EMP001',
    },
  });

  await prisma.userAccess.create({
    data: {
      userId: superAdmin.id,
      roleCode: null,
      nodeId: rootNode.id,
      accessType: null,
      companyId: company.id,
      isGlobalAccess: true,
    },
  });
  
  console.log('Super Admin mapping and global access configured.');

}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
