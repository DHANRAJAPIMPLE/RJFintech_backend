import { prisma } from '../lib/prisma';

type AuditUser = {
  id?: string | null;
  name?: string | null;
  email?: string | null;
};

/**
 * History screens display SAAS admin actions as Teams. The lookup is global
 * because SAAS admins are platform users and may not be mapped to the company
 * whose history is being viewed.
 */
export class HistoryUserUtil {
  static async getSaasAdminUserIds(userIds: (string | null | undefined)[]) {
    const uniqueUserIds = Array.from(
      new Set(userIds.filter((userId): userId is string => Boolean(userId))),
    );
    if (uniqueUserIds.length === 0) return new Set<string>();

    const saasAdminAccesses = await prisma.userAccess.findMany({
      where: {
        userId: { in: uniqueUserIds },
        roleCode: 'SAAS_ADMIN',
      },
      select: { userId: true },
    });

    return new Set(saasAdminAccesses.map((access) => access.userId));
  }

  static formatAuditUser(
    user: AuditUser | null | undefined,
    eventUserId: string | null | undefined,
    saasAdminUserIds: Set<string>,
    viewerUserId?: string | null,
  ) {
    const viewerIsSaasAdmin = Boolean(
      viewerUserId && saasAdminUserIds.has(viewerUserId),
    );

    if (
      eventUserId &&
      eventUserId !== viewerUserId &&
      !viewerIsSaasAdmin &&
      saasAdminUserIds.has(eventUserId)
    ) {
      return { name: 'Teams', email: 'Teams' };
    }

    return {
      name: user?.name || 'System',
      email: user?.email || 'system@internal',
    };
  }
}
