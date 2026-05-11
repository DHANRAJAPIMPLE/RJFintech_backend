import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkGlobalUsers() {
  const companyCode = 'TEST28042026';
  const company = await prisma.company.findUnique({ where: { companyCode } });
  
  if (!company) {
    console.log('Company not found');
    return;
  }

  const accesses = await prisma.userAccess.findMany({
    where: {
      companyId: company.id,
      isGlobalAccess: true,
    },
    include: {
      user: true,
      role: true,
    }
  });

  console.log(`Found ${accesses.length} global access records for company ${companyCode}:`);
  accesses.forEach(a => {
    console.log({
      userName: a.user.name,
      email: a.user.email,
      roleCode: a.roleCode,
      category: a.role?.category,
      subCategory: a.role?.subCategory,
      approvePermission: a.role?.approve
    });
  });
}

checkGlobalUsers()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
