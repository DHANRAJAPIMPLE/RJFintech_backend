import { prisma } from '../lib/prisma';
import { Status } from '@prisma/client';

/**
 * Utility class for performing centralized authorization and permission checks.
 * Encapsulates complex Prisma queries to identify eligible users for various actions.
 */
export class AccessUtil {
  /**
   * Fetches all user IDs that have 'Global Access' enabled for a specific company.
   * Logic:
   * - userAccess record must have isGlobalAccess = true.
   * - User must have an ACTIVE mapping to the specified company.
   */
  static async getGlobalAccessUserIds(companyCode: string): Promise<string[]> {
    if (!companyCode) return [];
    const accessRecords = await prisma.userAccess.findMany({
      where: {
        isGlobalAccess: true,
        company: {
          companyCode: companyCode,
        },
        // We verify the user is ACTIVE in this company context
        user: {
          userMappings: {
            some: {
              company: {
                companyCode: companyCode,
              },
              status: Status.ACTIVE,
            },
          },
        },
      },
      select: { userId: true },
    });
    // Use Set to ensure unique user IDs (de-duplication)
    return Array.from(new Set(accessRecords.map((record) => record.userId)));
  }

  /**
   * Fetches user IDs for a given company and role that have a specific permission (e.g., 'approve', 'modify').
   * This is used for granular module-based authorization.
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
        // Ensure user is ACTIVE
        user: {
          userMappings: {
            some: {
              company: {
                companyCode: companyCode,
              },
              status: Status.ACTIVE,
            },
          },
        },

        // Role-based filtering
        roleCode: roleCode,
        role: {
          [action]: true, // Check if the specific action flag is enabled on the role
        },
      },
      select: { userId: true },
    });

    return Array.from(new Set(accessRecords.map((record) => record.userId)));
  }

  /**
   * Fetches user IDs for a given company and role regardless of granular permissions.
   * Used primarily for administrative roles like 'SAAS_ADMIN' or to identify 'Global Access' users.
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
        // Verify user activity status
        user: {
          userMappings: {
            some: {
              company: {
                companyCode: companyCode,
              },
              status: Status.ACTIVE,
            },
          },
        },
        // Matches if user has either Global Access OR the specific role requested
        OR: [{ isGlobalAccess: true }, { roleCode: roleCode }],
      },
      select: { userId: true },
    });

    return Array.from(new Set(accessRecords.map((record) => record.userId)));
  }
}
