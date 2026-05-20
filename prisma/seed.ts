import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
 
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
config({ path: path.resolve(__dirname, '../.env') });
 
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
 
const prisma = new PrismaClient();
 
async function main() {
  console.log('Seeding database...');

const roles = [
    {
      roleCode: 'SAAS_ADMIN',
      roleName: 'Saas Admin',
      category: 'SAAS_ADMIN',
      subCategory: 'SAAS_ADMIN',
      permissionLevel: 'SAAS_ADMIN',
      view: true,
      modify: true,
      approve: true,
      initiate: true,
    },
    {
      roleCode: 'CORP_ADMIN',
      roleName: 'Corp Admin',
      category: 'ALL',
      subCategory: 'ALL',
      permissionLevel: 'ALL',
      view: true,
      modify: true,
      approve: true,
      initiate: true,
    },
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
 
  // ─── Shared password for ALL seeded users ───────────────────────────────────
  const sharedPassword = await argon2.hash('Admin@123');
 
  // ─── 2. Seed Group & Company ─────────────────────────────────────────────────
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
      ieCode: '0123456789',
      companyCode: 'TEST28042026',
      registrationDate: new Date('2023-01-01'),
      status: 'ACTIVE',
    },
  });
 
  const mappingExists = await prisma.companyMapping.findUnique({
    where: { groupId_companyId: { groupId: group.id, companyId: company.id } },
  });
  if (!mappingExists) {
    await prisma.companyMapping.create({
      data: { companyId: company.id, groupId: group.id },
    });
  }
  console.log('Group and Company seeded.');
 
  // ─── 3. Root Org Node ────────────────────────────────────────────────────────
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
 
  // ─── Helper: ensure UserMapping exists ───────────────────────────────────────
  async function ensureUserMapping(
    userId: string,
    designation: string,
    employeeId: string,
    reportingManager?: string,
  ) {
    const exists = await prisma.userMapping.findUnique({
      where: { userId_companyId: { userId, companyId: company.id } },
    });
    if (!exists) {
      await prisma.userMapping.create({
        data: {
          userId,
          companyId: company.id,
          status: 'ACTIVE',
          designation,
          employeeId,
          ...(reportingManager ? { reportingManager } : {}),
        },
      });
    }
  }
 
  // ─── Helper: ensure UserAccess exists ────────────────────────────────────────
  async function ensureUserAccess(
    userId: string,
    roleCode: string,
    isGlobalAccess: boolean,
    accessCategory: string,
    accessType: string | null = null,
  ) {
    const exists = await prisma.userAccess.findUnique({
      where: {
        userId_roleCode_companyId_nodeId: {
          userId,
          roleCode,
          companyId: company.id,
          nodeId: rootNode.id,
        },
      },
    });
    if (!exists) {
      await prisma.userAccess.create({
        data: {
          userId,
          roleCode,
          nodeId: rootNode.id,
          accessType,
          companyId: company.id,
          isGlobalAccess,
          accessCategory,
        },
      });
    }
  }
 
  // ─── 4. SAAS Admins (2) ──────────────────────────────────────────────────────
  // SAAS admins are mapped to the company as normal users AND hold SAAS_ADMIN role.
  const saasAdmins = [
    {
      name: 'Arjun Mehta',
      email: 'arjun.mehta@saasplatform.com',
      phone: '9000000001',
      employeeId: 'SAAS001',
      designation: 'Platform Administrator',
    },
    {
      name: 'Priya Nair',
      email: 'priya.nair@saasplatform.com',
      phone: '9000000002',
      employeeId: 'SAAS002',
      designation: 'Platform Co-Administrator',
    },
  ];
 
  for (const sa of saasAdmins) {
    const user = await prisma.user.upsert({
      where: { email: sa.email },
      update: {},
      create: {
        name: sa.name,
        email: sa.email,
        password: sharedPassword,
        phone: sa.phone,
      },
    });
 
    // Map SAAS admin to the company just like any other user.
    await ensureUserMapping(user.id, sa.designation, sa.employeeId);
    // Grant SAAS_ADMIN role with global access on the root node.
    await ensureUserAccess(user.id, 'SAAS_ADMIN', true, 'ALL_CHILD', null);
    console.log(`SAAS Admin seeded: ${sa.name} <${sa.email}>`);
  }
 
  // ─── 5. Corp Admins (2) — mapped to the company ──────────────────────────────
  const corpAdmins = [
    {
      name: 'Rohan Desai',
      email: 'rohan.desai@testtech.com',
      phone: '9100000001',
      employeeId: 'EMP001',
      designation: 'Chief Technology Officer',
    },
    {
      name: 'Sneha Kulkarni',
      email: 'sneha.kulkarni@testtech.com',
      phone: '9100000002',
      employeeId: 'EMP002',
      designation: 'Chief Operating Officer',
    },
  ];
 
  for (const ca of corpAdmins) {
    const user = await prisma.user.upsert({
      where: { email: ca.email },
      update: {},
      create: {
        name: ca.name,
        email: ca.email,
        password: sharedPassword,
        phone: ca.phone,
      },
    });
 
    await ensureUserMapping(user.id, ca.designation, ca.employeeId);
    await ensureUserAccess(user.id, 'CORP_ADMIN', true, 'ALL_CHILD', null);
    console.log(`Corp Admin seeded: ${ca.name} <${ca.email}>`);
  }
 
  // ─── 6. Default Workflows ────────────────────────────────────────────────────
  const defaultWorkflows = [
    { name: 'USER_ACC_WORKFLOW_DEFAULT', subModule: 'USER_ACC', roleCode: 'USER_ACC_MGR' },
    { name: 'ORG_STR_WORKFLOW_DEFAULT',  subModule: 'ORG_STR',  roleCode: 'ORG_STR_MGR'  },
    { name: 'WORK_FLOW_WORKFLOW_DEFAULT', subModule: 'WORK_FLOW', roleCode: 'WORK_FLOW_MGR' },
  ];
 
  for (const dwf of defaultWorkflows) {
    const existingWorkflow = await prisma.workflow.findFirst({
      where: { companyId: company.id, subModule: dwf.subModule, name: dwf.name },
    });
 
    if (!existingWorkflow) {
      const workflow = await prisma.workflow.create({
        data: {
          name: dwf.name,
          alias: '1M_1C_D',
          module: 'SYSTEM_ACCESS',
          subModule: dwf.subModule,
          roleCode: dwf.roleCode,
          companyId: company.id,
          nodeId: rootNode.id,
          levelsHash: `DEFAULT_${dwf.subModule}_1M_1C_1`,
          levels: {
            create: [{ level: 1, approver1: 'NODE_APPROVER', approverType: 'OR' }],
          },
        },
      });
      console.log(`Default workflow '${dwf.name}' created with ID: ${workflow.id}`);
    }
  }
  console.log('Default workflows seeded.');
 
  // ─── 7. Dummy Employees (10) ─────────────────────────────────────────────────
  // Realistic Indian names, reporting to the first Corp Admin.
  const [firstCorpAdmin] = await Promise.all([
    prisma.user.findUnique({ where: { email: corpAdmins[0]!.email } }),
  ]);
 
  const dummyEmployees = [
    { name: 'Vikram Sharma',    email: 'vikram.sharma@testtech.com',    phone: '9200000001', designation: 'Senior Accounts Executive',   employeeId: 'EMP003' },
    { name: 'Ananya Iyer',      email: 'ananya.iyer@testtech.com',      phone: '9200000002', designation: 'Payments Analyst',             employeeId: 'EMP004' },
    { name: 'Karthik Reddy',    email: 'karthik.reddy@testtech.com',    phone: '9200000003', designation: 'Purchase Manager',             employeeId: 'EMP005' },
    { name: 'Divya Pillai',     email: 'divya.pillai@testtech.com',     phone: '9200000004', designation: 'Finance Operations Lead',      employeeId: 'EMP006' },
    { name: 'Rahul Bose',       email: 'rahul.bose@testtech.com',       phone: '9200000005', designation: 'Master Data Steward',          employeeId: 'EMP007' },
    { name: 'Meera Joshi',      email: 'meera.joshi@testtech.com',      phone: '9200000006', designation: 'Org Structure Coordinator',    employeeId: 'EMP008' },
    { name: 'Siddharth Rao',    email: 'siddharth.rao@testtech.com',    phone: '9200000007', designation: 'User Access Specialist',       employeeId: 'EMP009' },
    { name: 'Pooja Agarwal',    email: 'pooja.agarwal@testtech.com',    phone: '9200000008', designation: 'Workflow Configuration Analyst', employeeId: 'EMP010' },
    { name: 'Nikhil Gupta',     email: 'nikhil.gupta@testtech.com',     phone: '9200000009', designation: 'Junior Accounts Executive',    employeeId: 'EMP011' },
    { name: 'Lakshmi Venkat',   email: 'lakshmi.venkat@testtech.com',   phone: '9200000010', designation: 'Payments Operations Executive', employeeId: 'EMP012' },
  ];
 
  const systemAccessRoles = [
    'USER_ACC_MGR', 'ORG_STR_MGR', 'WORK_FLOW_MGR',
    'USER_ACC_USER', 'ORG_STR_USER', 'WORK_FLOW_USER',
    'USER_ACC_VIEWER', 'ORG_STR_VIEWER', 'WORK_FLOW_VIEWER',
  ];
 
  for (let i = 0; i < dummyEmployees.length; i++) {
    const emp = dummyEmployees[i]!;
    const roleCode = systemAccessRoles[i % systemAccessRoles.length]!;
    const accessCategory = i % 2 === 0 ? 'NODE' : 'IMMEDIATE_CHILD';
 
    let user = await prisma.user.findUnique({ where: { email: emp.email } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          name: emp.name,
          email: emp.email,
          password: sharedPassword,
          phone: emp.phone,
        },
      });
    }
 
    await ensureUserMapping(
      user.id,
      emp.designation,
      emp.employeeId,
      firstCorpAdmin?.id,
    );
 
    await ensureUserAccess(user.id, roleCode, false, accessCategory, 'PRIMARY');
    console.log(`Employee seeded: ${emp.name} — ${roleCode}`);
  }
 
  console.log('\n✅ All seeding complete.');
  console.log('─────────────────────────────────────────────────');
  console.log('Password for ALL users: Admin@123');
  console.log('─────────────────────────────────────────────────');
  console.log('SAAS Admins:');
  saasAdmins.forEach(u => console.log(`  ${u.email}`));
  console.log('Corp Admins (mapped to TEST28042026):');
  corpAdmins.forEach(u => console.log(`  ${u.email}`));
  console.log('─────────────────────────────────────────────────');
}
 
main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });