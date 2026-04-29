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
          is: {
            companyCode: companyCode
          }
        }
      },
      select: { userId: true },
    });
    // Use Set to ensure unique user IDs
    return Array.from(new Set(accessRecords.map((record) => record.userId)));
  }

  /**
   * Verifies if a specific user ID is present in the provided list of permitted users.
   */
  static isUserPermitted(userId: string, permittedUsers: string[]): boolean {
    return permittedUsers.includes(userId);
  }
}
