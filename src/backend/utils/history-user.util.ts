import { prisma } from '../lib/prisma';

type AuditUser = {
  id?: string | null;
  name?: string | null;
  email?: string | null;
};

type UserHistoryDetailNewDataParams = {
  requestData: unknown;
  resolvedNewData: unknown;
  requestType?: string | null;
};

/**
 * History screens display SAAS admin actions as Teams. The lookup is global
 * because SAAS admins are platform users and may not be mapped to the company
 * whose history is being viewed.
 */
export class HistoryUserUtil {
  private static cloneJson<T>(value: T): T {
    if (value === undefined) return value;
    return JSON.parse(JSON.stringify(value)) as T;
  }

  private static isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  private static isPermissionRemoval(permission: unknown) {
    if (!HistoryUserUtil.isPlainObject(permission)) return false;

    const operation =
      typeof permission.operation === 'string'
        ? permission.operation.trim().toUpperCase()
        : '';

    return permission.remove === true || operation === 'REMOVE';
  }

  private static normalizePermissionChanges(permissions: unknown) {
    if (Array.isArray(permissions)) {
      return permissions
        .filter((permission) => !HistoryUserUtil.isPermissionRemoval(permission))
        .map((permission) => HistoryUserUtil.cloneJson(permission));
    }

    if (!HistoryUserUtil.isPlainObject(permissions)) {
      return null;
    }

    return [
      ...(Array.isArray(permissions.added) ? permissions.added : []),
      ...(Array.isArray(permissions.updated) ? permissions.updated : []),
    ]
      .filter((permission) => !HistoryUserUtil.isPermissionRemoval(permission))
      .map((permission) => HistoryUserUtil.cloneJson(permission));
  }

  static formatUserHistoryDetailNewData({
    requestData,
    resolvedNewData,
    requestType,
  }: UserHistoryDetailNewDataParams) {
    const normalizedType = String(requestType || 'INITIATE').toUpperCase();

    if (normalizedType === 'INITIATE') {
      return HistoryUserUtil.cloneJson(resolvedNewData ?? null);
    }

    if (!HistoryUserUtil.isPlainObject(requestData)) {
      return HistoryUserUtil.cloneJson(resolvedNewData ?? null);
    }

    const source = HistoryUserUtil.isPlainObject(requestData.newData)
      ? requestData.newData
      : HistoryUserUtil.isPlainObject(requestData.data)
        ? requestData.data
        : requestData;
    const newData: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(source)) {
      if (
        key === 'oldData' ||
        key === 'changeCount' ||
        key === 'permissions'
      ) {
        continue;
      }

      if (
        key === 'basicDetails' &&
        HistoryUserUtil.isPlainObject(value) &&
        Object.keys(value).length === 0
      ) {
        continue;
      }

      newData[key] = HistoryUserUtil.cloneJson(value);
    }

    const permissionChanges = HistoryUserUtil.normalizePermissionChanges(
      source.permissions,
    );
    if (permissionChanges && permissionChanges.length > 0) {
      newData.permissions = permissionChanges;
    }

    return Object.keys(newData).length > 0 ? newData : null;
  }

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
