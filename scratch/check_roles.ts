import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const role = await prisma.roles.findUnique({
    where: { role_code: 'SYS_ADMIN_MGR' }
  });
  console.log('Role SYS_ADMIN_MGR exists:', !!role);
  
  const allRoles = await prisma.roles.findMany({
    select: { role_code: true }
  });
  console.log('Available role codes:', allRoles.map(r => r.role_code));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
