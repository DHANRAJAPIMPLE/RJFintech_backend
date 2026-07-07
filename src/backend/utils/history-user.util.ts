import { prisma } from '../lib/prisma';

type AuditUser = {
  id?: string | null;
  name?: string | null;
  email?: string | null;
};

type UserHistoryDetailNewDataParams = {
  requestData: unknown;
  requestOldData?: unknown;
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

  private static normalizePermission(permission: unknown) {
    if (!HistoryUserUtil.isPlainObject(permission)) {
      return {
        accessType: 'SECONDARY',
        roleName: '',
        roleCategory: '',
        roleSubCategory: '',
        nodeName: '',
        nodePath: '',
        nodeType: '',
        accessCategory: null,
        sourceTag: 'USER',
      };
    }

    const sourceTag =
      permission.sourceTag === 'AUTO_GENERATED' ||
      permission.source === 'AUTO_GENERATED' ||
      permission.sourceType === 'AUTO_GENERATED'
        ? 'AUTO_GENERATED'
        : 'USER';

    return {
      accessType: String(permission.accessType || 'SECONDARY'),
      roleName: String(permission.roleName || ''),
      roleCategory: String(permission.roleCategory || ''),
      roleSubCategory: String(permission.roleSubCategory || ''),
      nodeName: String(permission.nodeName || ''),
      nodePath: String(permission.nodePath || ''),
      nodeType: String(permission.nodeType || ''),
      accessCategory:
        permission.accessCategory === undefined ? null : permission.accessCategory,
      sourceTag,
    };
  }

  private static permissionHistoryChangeKey(permission: unknown) {
    const normalized = HistoryUserUtil.normalizePermission(permission);

    return [
      normalized.roleSubCategory,
      normalized.roleName,
      normalized.nodePath,
    ].join('|');
  }

  private static isPermissionRemoval(permission: unknown) {
    if (!HistoryUserUtil.isPlainObject(permission)) return false;

    const operation =
      typeof permission.operation === 'string'
        ? permission.operation.trim().toUpperCase()
        : '';

    return permission.remove === true || operation === 'REMOVE';
  }

  private static buildPermissionChangesFromRequestData(
    requestData: unknown,
    requestOldData: unknown,
  ) {
    const source = HistoryUserUtil.isPlainObject(requestData)
      ? HistoryUserUtil.isPlainObject(requestData.newData)
        ? requestData.newData
        : HistoryUserUtil.isPlainObject(requestData.data)
          ? requestData.data
          : requestData
      : null;
    const requestPermissions = Array.isArray(source?.permissions)
      ? source.permissions
      : [];
    if (requestPermissions.length === 0) return null;

    const candidateOldPermissionsSource = HistoryUserUtil.isPlainObject(
      requestOldData,
    )
      ? requestOldData.permissions
      : null;
    const oldPermissionsSource: Record<string, unknown> | null =
      HistoryUserUtil.isPlainObject(candidateOldPermissionsSource)
        ? candidateOldPermissionsSource
        : null;
    const removedFromOldPatch = Array.isArray(oldPermissionsSource?.removed)
      ? oldPermissionsSource.removed.map((permission: unknown) =>
          HistoryUserUtil.cloneJson(permission),
        )
      : [];
    const updatedFromOldPatch = Array.isArray(oldPermissionsSource?.updated)
      ? oldPermissionsSource.updated.map((permission: unknown) =>
          HistoryUserUtil.cloneJson(permission),
        )
      : [];

    const removed = removedFromOldPatch;
    const updatedOldByKey = new Map(
      updatedFromOldPatch.map((permission: unknown) => [
        HistoryUserUtil.permissionHistoryChangeKey(permission),
        permission,
      ]),
    );
    const removedOldByKey = new Set(
      removed.map((permission: unknown) =>
        HistoryUserUtil.permissionHistoryChangeKey(permission),
      ),
    );

    const added: unknown[] = [];
    const updated: unknown[] = [];
    for (const permission of requestPermissions) {
      if (HistoryUserUtil.isPermissionRemoval(permission)) {
        continue;
      }

      const normalizedPermission = HistoryUserUtil.normalizePermission(permission);
      const replacementKey =
        HistoryUserUtil.permissionHistoryChangeKey(normalizedPermission);

      if (updatedOldByKey.has(replacementKey)) {
        updated.push(HistoryUserUtil.cloneJson(normalizedPermission));
      } else if (removedOldByKey.has(replacementKey)) {
        updated.push(HistoryUserUtil.cloneJson(normalizedPermission));
        removedOldByKey.delete(replacementKey);
      } else {
        added.push(HistoryUserUtil.cloneJson(normalizedPermission));
      }
    }

    if (added.length === 0 && removed.length === 0 && updated.length === 0) {
      return null;
    }

    return { added, removed, updated };
  }

  private static appendRequestPassthroughFields(
    target: Record<string, unknown>,
    requestData: unknown,
  ) {
    if (!HistoryUserUtil.isPlainObject(requestData)) {
      return target;
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

      target[key] = HistoryUserUtil.cloneJson(value);
    }

    return target;
  }

  static formatUserHistoryDetailNewData({
    requestData,
    requestOldData,
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
      if (!HistoryUserUtil.isPlainObject(requestData)) {
        return HistoryUserUtil.cloneJson(requestData ?? resolvedNewData ?? null);
      }

      const fallbackNewData: Record<string, unknown> = {};
      const source = HistoryUserUtil.isPlainObject(requestData.newData)
        ? requestData.newData
        : HistoryUserUtil.isPlainObject(requestData.data)
          ? requestData.data
          : requestData;
      if (HistoryUserUtil.isPlainObject(source.basicDetails)) {
        fallbackNewData.basicDetails = HistoryUserUtil.cloneJson(
          source.basicDetails,
        );
      }

      const fallbackPermissionChanges =
        HistoryUserUtil.buildPermissionChangesFromRequestData(
          requestData,
          requestOldData,
        );
      if (fallbackPermissionChanges) {
        fallbackNewData.permissions = fallbackPermissionChanges;
      }

      HistoryUserUtil.appendRequestPassthroughFields(
        fallbackNewData,
        requestData,
      );

      return Object.keys(fallbackNewData).length > 0
        ? fallbackNewData
        : HistoryUserUtil.cloneJson(resolvedNewData ?? requestData ?? null);
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

      return [
        permission.roleSubCategory || '',
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

    const requestPermissionChanges =
      HistoryUserUtil.buildPermissionChangesFromRequestData(
        requestData,
        requestOldData,
      );
    if (
      requestPermissionChanges &&
      !newData.permissions &&
      (!resolvedOldData || !resolvedNewData)
    ) {
      newData.permissions = requestPermissionChanges;
    }

    HistoryUserUtil.appendRequestPassthroughFields(newData, requestData);

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
