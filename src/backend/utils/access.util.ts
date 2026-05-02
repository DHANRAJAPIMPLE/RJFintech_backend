import { prisma } from '../lib/prisma';

export class AccessUtil {
  /**
   * Fetches all user IDs that have global access.
   */
  static async getGlobalAccessUserIds(companyCode: string): Promise<string[]> {
    if (!companyCode) return [];
    const accessRecords = await prisma.userAccess.findMany({
      where: {
        isGlobalAccess: true,
        company: {
          companyCode: companyCode,
        },
        user: {
          userMappings: {
            some: {
              company: {
                companyCode: companyCode,
              },
              status: 'ACTIVE',
            },
          },
        },
      },
      select: { userId: true },
    });
    // Use Set to ensure unique user IDs
    return Array.from(new Set(accessRecords.map((record) => record.userId)));
  }

  /**
   * Fetches all users that have global access for a particular company.
   */
  static async getGlobalAccessUsers(companyCode: string) {
    if (!companyCode) return [];
    const accessRecords = await prisma.userAccess.findMany({
      where: {
        isGlobalAccess: true,
        company: {
          companyCode: companyCode,
        },
        user: {
          userMappings: {
            some: {
              company: {
                companyCode: companyCode,
              },
              status: 'ACTIVE',
            },
          },
        },
      },
      include: {
        user: true,
      },
    });
    // Return unique users
    const users = accessRecords.map((record) => record.user);
    const uniqueUsers = Array.from(
      new Map(users.map((u) => [u.id, u])).values(),
    );
    return uniqueUsers;
  }

  /**
   * Verifies if a specific user ID is present in the provided list of permitted users.
   */
  static isUserPermitted(userId: string, permittedUsers: string[]): boolean {
    return permittedUsers.includes(userId);
  }

  /**
   * Fetches user IDs for a given company and role that have a specific permission (e.g., 'approve').
   */
  static async getUsersByRoleAndAction(
    companyCode: string,
    roleCode: string,
    action: 'view' | 'modify' | 'approve' | 'initiate',
  ): Promise<string[]> {
    if (!companyCode || !roleCode) return [];

    const accessRecords = await prisma.userAccess.findMany({
      where: {
        company: {
          companyCode: companyCode,
        },
        user: {
          userMappings: {
            some: {
              company: {
                companyCode: companyCode,
              },
              status: 'ACTIVE',
            },
          },
        },

        roleCode: roleCode,
        role: {
          [action]: true,
        },
      },
      select: { userId: true },
    });

    return Array.from(new Set(accessRecords.map((record) => record.userId)));
  }

  /**
   * Fetches user IDs for a given company and role regardless of permissions.
   */
  static async getUsersByRole(
    companyCode: string,
    roleCode: string,
  ): Promise<string[]> {
    if (!companyCode || !roleCode) return [];

    const accessRecords = await prisma.userAccess.findMany({
      where: {
        company: {
          companyCode: companyCode,
        },
        user: {
          userMappings: {
            some: {
              company: {
                companyCode: companyCode,
              },
              status: 'ACTIVE',
            },
          },
        },
        OR: [{ isGlobalAccess: true }, { roleCode: roleCode }],
      },
      select: { userId: true },
    });

    return Array.from(new Set(accessRecords.map((record) => record.userId)));
  }
}
