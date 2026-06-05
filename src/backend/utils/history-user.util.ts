import { prisma } from '../lib/prisma';

type AuditUser = {
  id?: string | null;
  name?: string | null;
  email?: string | null;
};

type UserHistoryDetailNewDataParams = {
  requestData: unknown;
  resolvedOldData?: unknown;
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

  static formatUserHistoryDetailNewData({
    requestData,
    resolvedOldData,
    resolvedNewData,
    requestType,
  }: UserHistoryDetailNewDataParams) {
    const normalizedType = String(requestType || 'INITIATE').toUpperCase();

    if (normalizedType === 'INITIATE') {
      return HistoryUserUtil.cloneJson(resolvedNewData ?? null);
    }

    if (
      !HistoryUserUtil.isPlainObject(resolvedOldData) ||
      !HistoryUserUtil.isPlainObject(resolvedNewData)
    ) {
      return HistoryUserUtil.cloneJson(requestData ?? resolvedNewData ?? null);
    }

    const newData: Record<string, unknown> = {};
    const oldBasicDetails = HistoryUserUtil.isPlainObject(
      resolvedOldData.basicDetails,
    )
      ? resolvedOldData.basicDetails
      : {};
    const newBasicDetails = HistoryUserUtil.isPlainObject(
      resolvedNewData.basicDetails,
    )
      ? resolvedNewData.basicDetails
      : {};
    const basicDetailsPatch: Record<string, unknown> = {};

    const basicDetailKeys = new Set([
      ...Object.keys(oldBasicDetails),
      ...Object.keys(newBasicDetails),
    ]);
    for (const key of basicDetailKeys) {
      if (oldBasicDetails[key] !== newBasicDetails[key]) {
        basicDetailsPatch[key] = HistoryUserUtil.cloneJson(
          newBasicDetails[key],
        );
      }
    }
    if (Object.keys(basicDetailsPatch).length > 0) {
      newData.basicDetails = basicDetailsPatch;
    }

    const oldPermissions = Array.isArray(resolvedOldData.permissions)
      ? resolvedOldData.permissions
      : [];
    const newPermissions = Array.isArray(resolvedNewData.permissions)
      ? resolvedNewData.permissions
      : [];
    const permissionKey = (permission: unknown) => {
      if (!HistoryUserUtil.isPlainObject(permission)) return '';
      if (permission.accessType === 'PRIMARY') return 'PRIMARY';

      return [
        permission.accessType || 'SECONDARY',
        permission.roleName || '',
        permission.nodePath || '',
      ].join('|');
    };
    const permissionEquals = (left: unknown, right: unknown) =>
      JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
    const removed = oldPermissions.filter(
      (permission) =>
        !newPermissions.some((candidate) =>
          permissionEquals(permission, candidate),
        ),
    );
    const added = newPermissions.filter(
      (permission) =>
        !oldPermissions.some((candidate) =>
          permissionEquals(permission, candidate),
        ),
    );
    const pairedAdded = new Set<number>();
    const pairedRemoved = new Set<number>();
    const updated: unknown[] = [];

    removed.forEach((oldPermission, oldIndex) => {
      const newIndex = added.findIndex(
        (newPermission, index) =>
          !pairedAdded.has(index) &&
          permissionKey(oldPermission) === permissionKey(newPermission),
      );

      if (newIndex >= 0) {
        pairedRemoved.add(oldIndex);
        pairedAdded.add(newIndex);
        updated.push(HistoryUserUtil.cloneJson(added[newIndex]));
      }
    });

    const permissionChanges = {
      added: added
        .filter((_, index) => !pairedAdded.has(index))
        .map((permission) => HistoryUserUtil.cloneJson(permission)),
      removed: removed
        .filter((_, index) => !pairedRemoved.has(index))
        .map((permission) => HistoryUserUtil.cloneJson(permission)),
      updated,
    };
    if (
      permissionChanges.added.length > 0 ||
      permissionChanges.removed.length > 0 ||
      permissionChanges.updated.length > 0
    ) {
      newData.permissions = permissionChanges;
    }

    if (!HistoryUserUtil.isPlainObject(requestData)) {
      return Object.keys(newData).length > 0 ? newData : null;
    }

    const source = HistoryUserUtil.isPlainObject(requestData.newData)
      ? requestData.newData
      : HistoryUserUtil.isPlainObject(requestData.data)
        ? requestData.data
        : requestData;
    for (const [key, value] of Object.entries(source)) {
      if (
        key === 'oldData' ||
        key === 'changeCount' ||
        key === 'targetUserEmail' ||
        key === 'levelsHash' ||
        key === 'basicDetails' ||
        key === 'permissions'
      ) {
        continue;
      }

      newData[key] = HistoryUserUtil.cloneJson(value);
    }

    return Object.keys(newData).length > 0 ? newData : null;
  }

  static async enrichUserHistoryOldData(oldData: unknown) {
    const enrichedOldData = HistoryUserUtil.cloneJson(oldData ?? null);
    if (
      !HistoryUserUtil.isPlainObject(enrichedOldData) ||
      !HistoryUserUtil.isPlainObject(enrichedOldData.basicDetails)
    ) {
      return enrichedOldData;
    }

    const reportingManager = enrichedOldData.basicDetails.reportingManager;
    if (typeof reportingManager !== 'string' || !reportingManager.trim()) {
      enrichedOldData.basicDetails.reportingManagerName = null;
      return enrichedOldData;
    }

    const manager = await prisma.user.findUnique({
      where: { email: reportingManager },
      select: { name: true },
    });
    enrichedOldData.basicDetails.reportingManagerName = manager?.name || null;

    return enrichedOldData;
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
