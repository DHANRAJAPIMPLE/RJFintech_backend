import type { Request, Response, NextFunction } from 'express';
import { prisma, ltree } from '../../lib/prisma';
import { HashUtil } from '../../../shared/utils/hash.util';
import { AppError } from '../../middlewares/error.middleware';
import { getPagination } from '../../../shared/utils/pagination.util';
import { WorkflowApproverUtil } from '../../utils/workflow-approver.util';
import { NotificationService } from '../notifications/notification.db.modules';
import { HistoryUserUtil } from '../../utils/history-user.util';
import {
  buildJsonPatch,
  cloneJson,
} from '../../utils/json-patch.util';

type TextFilterOption = {
  label: string;
  value: string;
};

type NodeFilterOption = {
  label: string;
  value: string;
  nodeName: string;
  nodePath: string;
  nodeType: string | null;
};

type ManagerFilterOption = {
  label: string;
  value: string;
  id: string | null;
  name: string | null;
  email: string;
};

type CompanyNodeWorkflowOption = {
  id?: string;
  levelsHash: string;
  name: string;
  alias: string;
  status?: string;
  module?: string;
  subModule?: string;
  nodePath?: string;
};

type UserRequestType =
  | 'INITIATE'
  | 'UPDATE'
  | 'ACTIVE'
  | 'INACTIVE'
  | 'ARCHIVE';

type UserPermissionSnapshot = {
  accessType: 'PRIMARY' | 'SECONDARY';
  roleName: string;
  roleCategory: string;
  roleSubCategory: string;
  nodeName: string;
  nodePath: string;
  accessCategory: 'ALL_CHILD' | 'IMMEDIATE_CHILD' | 'NODE' | null;
};

type UserDataSnapshot = {
  basicDetails: {
    name: string;
    email: string;
    phone: string;
    designation: string | null;
    employeeId: string | null;
    reportingManager: string | null;
    status: string;
  };
  permissions: UserPermissionSnapshot[];
};

type UserPermissionDiff = {
  added: UserPermissionSnapshot[];
  removed: UserPermissionSnapshot[];
  updated: Array<{
    oldData: UserPermissionSnapshot;
    newData: UserPermissionSnapshot;
  }>;
};

type HistoryChangeCount = {
  added: number;
  modify: number;
  remove: number;
};

/**
 * Controller for managing user accounts, mappings to companies, and onboarding workflows.
 * Handles production user data and pending user requests.
 */
export class UserDbController {
  private static pathsOverlap(left: string, right: string) {
    return (
      left === right ||
      left.startsWith(`${right}.`) ||
      right.startsWith(`${left}.`)
    );
  }

  private static formatConflictDate(value: Date | string | null | undefined) {
    if (!value) return 'N/A';
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? 'N/A' : date.toISOString();
  }

  private static async notifyConflict(
    companyId: string,
    initiatorId: string,
    message: string,
    referenceName: string,
    approverUserIds: string[] = [],
  ) {
    const corpAdminUserIds = await NotificationService.getCorpAdminUserIds(
      companyId,
    );
    const recipients = NotificationService.mergeRecipientUserIds(
      initiatorId,
      approverUserIds,
      corpAdminUserIds,
    );
    await NotificationService.createRequestNotification({
      companyId,
      type: 'MODIFICATION',
      name: 'User modification failed',
      message: `User modification failed: ${message}`,
      referenceType: 'USER',
      referenceName,
      createdBy: initiatorId,
      recipientUserIds: recipients,
      requiredRecipientUserIds: NotificationService.mergeRecipientUserIds(
        initiatorId,
        approverUserIds,
      ),
      includeCreatedBy: true,
      isPending: false,
    });
  }
  private static normalizeUserRequestType(value: unknown): UserRequestType {
    const type =
      typeof value === 'string' ? value.trim().toUpperCase() : 'INITIATE';
    const accepted: UserRequestType[] = [
      'INITIATE',
      'UPDATE',
      'ACTIVE',
      'INACTIVE',
      'ARCHIVE',
    ];

    if (!accepted.includes(type as UserRequestType)) {
      throw new AppError('Invalid user request type', 400);
    }

    return type as UserRequestType;
  }

  private static getUserNotificationContent(
    type: string | null | undefined,
    phase: 'initiated' | 'approved' | 'rejected',
    referenceName: string,
  ) {
    const normalizedType = String(type || 'INITIATE').toUpperCase();
    const label =
      normalizedType === 'UPDATE'
        ? 'User modification'
        : normalizedType === 'ACTIVE'
          ? 'User activation'
          : normalizedType === 'INACTIVE'
            ? 'User inactivation'
            : normalizedType === 'ARCHIVE'
              ? 'User archive'
              : 'User onboarding';

    return {
      name: `${label} ${phase}`,
      message: `${label} request ${phase} for ${referenceName}`,
    };
  }

  private static formatUserReferenceName(
    user: { name?: string | null; email?: string | null },
    fallback = 'user',
  ) {
    const name = typeof user.name === 'string' ? user.name.trim() : '';
    const email = typeof user.email === 'string' ? user.email.trim() : '';

    if (name && email) return `${name} (${email})`;
    return name || email || fallback;
  }

  private static permissionSummaryKey(permission: any) {
    const roleName =
      typeof permission?.roleName === 'string' ? permission.roleName.trim() : '';
    const nodePath =
      typeof permission?.nodePath === 'string' ? permission.nodePath.trim() : '';
    return `${roleName}|${nodePath}`;
  }

  private static formatInitiatePermissionSummary(
    originalPermissions: any[],
    expandedPermissions: any[],
  ) {
    if (!Array.isArray(expandedPermissions) || expandedPermissions.length === 0) {
      return null;
    }

    const originalKeys = new Set(
      originalPermissions.map((permission) =>
        UserDbController.permissionSummaryKey(permission),
      ),
    );
    const generatedPermissions = expandedPermissions.filter(
      (permission) =>
        !originalKeys.has(UserDbController.permissionSummaryKey(permission)),
    );

    if (generatedPermissions.length === 0) {
      return `${expandedPermissions.length} role assignment(s)`;
    }

    const generatedRoleNames = Array.from(
      new Set(
        generatedPermissions
          .map((permission) =>
            typeof permission?.roleName === 'string'
              ? permission.roleName.trim()
              : '',
          )
          .filter(Boolean),
      ),
    );
    const preview = generatedRoleNames.slice(0, 3).join(', ');
    const remaining = Math.max(generatedRoleNames.length - 3, 0);
    const remainingText = remaining > 0 ? ` and ${remaining} more` : '';

    return `${expandedPermissions.length} role assignment(s), including ${generatedPermissions.length} auto-generated role assignment(s)${preview ? `: ${preview}${remainingText}` : ''}`;
  }

  private static getUserNotificationType(
    type: string | null | undefined,
    status: string | null | undefined,
  ) {
    const normalizedStatus = String(status || '').toUpperCase();
    if (normalizedStatus === 'REJECTED') return 'REJECT' as const;
    if (normalizedStatus === 'PARTIAL_APPROVED') return 'APPROVE' as const;

    const normalizedType = String(type || 'INITIATE').toUpperCase();
    if (normalizedType === 'UPDATE') return 'MODIFICATION' as const;
    if (normalizedType === 'ACTIVE') return 'ACTIVE' as const;
    if (normalizedType === 'INACTIVE') return 'INACTIVE' as const;
    if (normalizedType === 'ARCHIVE') return 'ARCHIVE' as const;
    if (normalizedStatus === 'APPROVED') return 'ONBOARDED' as const;

    return 'INITIATE' as const;
  }

  private static normalizePermission(permission: any): UserPermissionSnapshot {
    return {
      accessType: permission.accessType,
      roleName: permission.roleName,
      roleCategory: permission.roleCategory,
      roleSubCategory: permission.roleSubCategory,
      nodeName: permission.nodeName,
      nodePath: permission.nodePath,
      accessCategory: permission.accessCategory || null,
    };
  }

  private static normalizeChangeCount(value: unknown): HistoryChangeCount {
    if (!value || typeof value !== 'object') {
      return { added: 0, modify: 0, remove: 0 };
    }

    const source = value as Record<string, unknown>;
    return {
      added: Number(source.added) || 0,
      modify: Number(source.modify) || 0,
      remove: Number(source.remove) || 0,
    };
  }

  private static permissionMutationKey(permission: any) {
    return [
      permission?.accessType || 'SECONDARY',
      permission?.roleName || '',
      permission?.nodePath || '',
      permission?.accessCategory || '',
    ].join('|');
  }

  private static isPermissionRemoval(permission: any) {
    const operation =
      typeof permission?.operation === 'string'
        ? permission.operation.trim().toUpperCase()
        : '';

    return permission?.remove === true || operation === 'REMOVE';
  }

  private static getHistoryOldPermissions(
    oldData: any,
  ): UserPermissionSnapshot[] {
    const permissions = oldData?.permissions;
    if (Array.isArray(permissions)) {
      return permissions.map((permission) =>
        UserDbController.normalizePermission(permission),
      );
    }

    if (!permissions || typeof permissions !== 'object') {
      return [];
    }

    return [
      ...(Array.isArray(permissions.removed) ? permissions.removed : []),
      ...(Array.isArray(permissions.updated) ? permissions.updated : []),
    ].map((permission) => UserDbController.normalizePermission(permission));
  }

  private static getUserHistoryChangeCount(
    requestData: any,
    oldData: any,
    requestType: string | null | undefined,
  ): HistoryChangeCount {
    const stored = UserDbController.normalizeChangeCount(
      requestData?.changeCount ?? oldData?.changeCount,
    );
    if (stored.added || stored.modify || stored.remove) {
      return stored;
    }

    const normalizedType = String(requestType || '').toUpperCase();
    const mutations = Array.isArray(requestData?.permissions)
      ? requestData.permissions
      : [];

    if (normalizedType === 'INITIATE') {
      return {
        added: mutations.length,
        modify: 0,
        remove: 0,
      };
    }

    const oldPermissions = UserDbController.getHistoryOldPermissions(oldData);
    const oldPermissionKeys = new Set(
      oldPermissions.map((permission: any) =>
        UserDbController.permissionMutationKey(permission),
      ),
    );

    const counts: HistoryChangeCount = {
      added: 0,
      modify: 0,
      remove: 0,
    };

    for (const mutation of mutations) {
      const operation =
        typeof mutation?.operation === 'string'
          ? mutation.operation.trim().toUpperCase()
          : '';

      if (UserDbController.isPermissionRemoval(mutation)) {
        counts.remove += 1;
        continue;
      }

      const normalizedMutation =
        UserDbController.normalizePermission(mutation);
      const replacedPrimary = oldPermissions.find(
        (permission) => permission.accessType === 'PRIMARY',
      );
      if (
        normalizedMutation.accessType === 'PRIMARY' &&
        replacedPrimary &&
        !UserDbController.permissionsEqual(replacedPrimary, normalizedMutation)
      ) {
        counts.remove += 1;
        continue;
      }

      if (operation === 'UPDATE' || operation === 'MODIFY') {
        counts.modify += 1;
        continue;
      }

      if (operation === 'ADD') {
        counts.added += 1;
        continue;
      }

      if (oldPermissionKeys.has(UserDbController.permissionMutationKey(mutation))) {
        counts.modify += 1;
      } else {
        counts.added += 1;
      }
    }

    return counts;
  }

  private static permissionsEqual(
    left: UserPermissionSnapshot,
    right: UserPermissionSnapshot,
  ) {
    return (
      left.accessType === right.accessType &&
      left.roleName === right.roleName &&
      left.roleCategory === right.roleCategory &&
      left.roleSubCategory === right.roleSubCategory &&
      left.nodeName === right.nodeName &&
      left.nodePath === right.nodePath &&
      left.accessCategory === right.accessCategory
    );
  }

  private static permissionReplacementKey(permission: UserPermissionSnapshot) {
    if (permission.accessType === 'PRIMARY') return 'PRIMARY';

    // Secondary permissions are role-scoped because one node can grant several
    // system-access roles to the same user.
    return [
      permission.accessType,
      permission.roleName,
      permission.nodePath,
    ].join('|');
  }

  private static mergePermissionMutations(
    existing: UserPermissionSnapshot[],
    requested: any[],
  ): UserPermissionSnapshot[] {
    const proposed = existing.map((permission) => ({ ...permission }));

    for (const request of requested) {
      const permission = UserDbController.normalizePermission(request);
      const operation =
        request.remove === true
          ? 'REMOVE'
          : typeof request.operation === 'string'
            ? request.operation.toUpperCase()
            : null;
      const exactIndex = proposed.findIndex((stored) =>
        UserDbController.permissionsEqual(stored, permission),
      );
      const replacementIndex = proposed.findIndex(
        (stored) =>
          UserDbController.permissionReplacementKey(stored) ===
          UserDbController.permissionReplacementKey(permission),
      );

      if (operation === 'REMOVE') {
        if (permission.accessType === 'PRIMARY') {
          throw new AppError(
            'PRIMARY permission cannot be removed. Overwrite it with another PRIMARY permission instead.',
            400,
          );
        }
        const index = exactIndex >= 0 ? exactIndex : replacementIndex;
        if (index >= 0) proposed.splice(index, 1);
        continue;
      }

      if (permission.accessType === 'PRIMARY') {
        for (let index = proposed.length - 1; index >= 0; index--) {
          if (proposed[index]?.accessType === 'PRIMARY') {
            proposed.splice(index, 1);
          }
        }
        proposed.push(permission);
        continue;
      }

      const index = exactIndex >= 0 ? exactIndex : replacementIndex;
      if (index >= 0) {
        proposed[index] = permission;
      } else {
        proposed.push(permission);
      }
    }

    return proposed;
  }

  private static buildPermissionDiff(
    existing: UserPermissionSnapshot[],
    proposed: UserPermissionSnapshot[],
  ): UserPermissionDiff {
    const removed = existing.filter(
      (permission) =>
        !proposed.some((candidate) =>
          UserDbController.permissionsEqual(permission, candidate),
        ),
    );
    const added = proposed.filter(
      (permission) =>
        !existing.some((candidate) =>
          UserDbController.permissionsEqual(permission, candidate),
        ),
    );
    const pairedAdded = new Set<number>();
    const pairedRemoved = new Set<number>();
    const updated: UserPermissionDiff['updated'] = [];

    removed.forEach((oldData, oldIndex) => {
      const newIndex = added.findIndex(
        (newData, index) =>
          !pairedAdded.has(index) &&
          UserDbController.permissionReplacementKey(oldData) ===
          UserDbController.permissionReplacementKey(newData),
      );

      if (newIndex >= 0) {
        pairedRemoved.add(oldIndex);
        pairedAdded.add(newIndex);
        updated.push({ oldData, newData: added[newIndex]! });
      }
    });

    return {
      removed: removed.filter((_, index) => !pairedRemoved.has(index)),
      added: added.filter((_, index) => !pairedAdded.has(index)),
      updated,
    };
  }

  private static buildUserHistoryChangeData(
    current: UserDataSnapshot,
    proposed: UserDataSnapshot,
    permissionDiff: UserPermissionDiff,
  ) {
    const basicDetailsPatch = buildJsonPatch(
      current.basicDetails,
      proposed.basicDetails,
    );
    const oldData: Record<string, unknown> = {};
    const newData: Record<string, unknown> = {};

    if (basicDetailsPatch) {
      oldData.basicDetails = basicDetailsPatch.oldData;
      newData.basicDetails = basicDetailsPatch.newData;
    }

    const hasPermissionChanges =
      permissionDiff.added.length > 0 ||
      permissionDiff.removed.length > 0 ||
      permissionDiff.updated.length > 0;

    if (hasPermissionChanges) {
      oldData.permissions = {
        added: [],
        removed: permissionDiff.removed,
        updated: permissionDiff.updated.map((change) => change.oldData),
      };
      newData.permissions = {
        added: permissionDiff.added,
        removed: [],
        updated: permissionDiff.updated.map((change) => change.newData),
      };
    }

    return {
      oldData: Object.keys(oldData).length > 0 ? oldData : null,
      newData: Object.keys(newData).length > 0 ? newData : null,
    };
  }

  private static normalizeUserSnapshotSource(data: any) {
    return data?.newData ?? data?.data ?? data ?? {};
  }

  private static extractUserTargetEmail(data: any): string | null {
    const source = UserDbController.normalizeUserSnapshotSource(data);
    const candidates = [
      data?.targetUserEmail,
      source?.targetUserEmail,
      source?.basicDetails?.email,
      source?.data?.basicDetails?.email,
      source?.newData?.basicDetails?.email,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim().toLowerCase();
      }
    }

    return null;
  }

  private static extractUserSnapshot(data: any): UserDataSnapshot | null {
    const source = UserDbController.normalizeUserSnapshotSource(data);
    const basicDetails = source?.basicDetails || source?.data?.basicDetails;
    const permissions = Array.isArray(source?.permissions)
      ? source.permissions
      : Array.isArray(source?.data?.permissions)
        ? source.data.permissions
        : [];

    if (!basicDetails) {
      return null;
    }

    return {
      basicDetails: {
        name: basicDetails.name || '',
        email: basicDetails.email || '',
        phone: basicDetails.phone || '',
        designation: basicDetails.designation ?? null,
        employeeId: basicDetails.employeeId ?? null,
        reportingManager: basicDetails.reportingManager ?? null,
        status: basicDetails.status || 'ACTIVE',
      },
      permissions: permissions.map((permission: any) => ({
        accessType: permission.accessType || 'SECONDARY',
        roleName: permission.roleName || '',
        roleCategory: permission.roleCategory || '',
        roleSubCategory: permission.roleSubCategory || '',
        nodeName: permission.nodeName || '',
        nodePath: permission.nodePath || '',
        accessCategory: permission.accessCategory || null,
      })),
    };
  }

  private static applyUserRequestSnapshot(
    current: UserDataSnapshot,
    request: any,
  ): UserDataSnapshot {
    const requestData = UserDbController.normalizeUserSnapshotSource(
      request?.data,
    );
    const next: UserDataSnapshot = cloneJson(current);

    if (request.type === 'ARCHIVE') {
      next.permissions = [];
      next.basicDetails.status = 'ARCHIVE';
    } else {
      const permissionMutations = Array.isArray(requestData?.permissions)
        ? requestData.permissions
        : [];

      if (permissionMutations.length > 0) {
        next.permissions = UserDbController.mergePermissionMutations(
          next.permissions,
          permissionMutations,
        );
      }

      const changedDetails =
        requestData?.basicDetails || requestData?.data?.basicDetails || {};
      const editableFields = [
        'name',
        'email',
        'phone',
        'designation',
        'employeeId',
        'reportingManager',
      ] as const;
      for (const field of editableFields) {
        if (changedDetails[field] !== undefined) {
          next.basicDetails[field] = changedDetails[field];
        }
      }

      if (request.type === 'ACTIVE') next.basicDetails.status = 'ACTIVE';
      if (request.type === 'INACTIVE') next.basicDetails.status = 'INACTIVE';
      if (request.type === 'ARCHIVE') next.basicDetails.status = 'ARCHIVE';
      if (changedDetails.status !== undefined) {
        next.basicDetails.status = changedDetails.status;
      }
    }

    return next;
  }

  private static buildUserSnapshotAroundRequest(
    requests: any[],
    selectedRequestId?: string | null,
  ) {
    if (!selectedRequestId) {
      return { oldData: null, newData: null };
    }

    const sortedRequests = [...requests].sort((left, right) => {
      const leftTime = left.createdAt.getTime();
      const rightTime = right.createdAt.getTime();
      if (leftTime !== rightTime) return leftTime - rightTime;
      return left.id.localeCompare(right.id);
    });

    const selectedRequest = sortedRequests.find(
      (request) => request.id === selectedRequestId,
    );
    if (!selectedRequest) {
      return { oldData: null, newData: null };
    }

    const selectedTargetEmail =
      UserDbController.extractUserTargetEmail(selectedRequest.data) || null;
    if (selectedRequest.type === 'INITIATE') {
      return {
        oldData: null,
        newData: UserDbController.extractUserSnapshot(selectedRequest.data),
      };
    }

    for (const startRequest of sortedRequests) {
      if (startRequest.createdAt > selectedRequest.createdAt) continue;
      if (startRequest.type !== 'INITIATE') continue;

      // Replay must begin from the original INITIATE snapshot. The stored
      // `oldData` payload is a diff, so using it as a base would drop removed
      // permissions and flatten the historical "old" state.
      const startSnapshot = UserDbController.extractUserSnapshot(
        startRequest.data,
      );
      if (!startSnapshot) continue;
      const startTargetEmail =
        UserDbController.extractUserTargetEmail(startRequest.data) ||
        startSnapshot.basicDetails.email.toLowerCase();
      if (selectedTargetEmail && startTargetEmail !== selectedTargetEmail) {
        continue;
      }

      let currentSnapshot: UserDataSnapshot | null = null;

      for (const request of sortedRequests) {
        if (request.createdAt < startRequest.createdAt) continue;
        if (request.createdAt > selectedRequest.createdAt) break;
        if (request.status === 'REJECTED' && request.id !== selectedRequestId) {
          continue;
        }

        const requestTargetEmail =
          UserDbController.extractUserTargetEmail(request.data) || null;
        const currentEmail =
          currentSnapshot?.basicDetails.email.toLowerCase() ||
          startSnapshot.basicDetails.email.toLowerCase();
        const startsChain = request.id === startRequest.id;
        const matchesCurrentUser =
          startsChain ||
          !requestTargetEmail ||
          requestTargetEmail === currentEmail ||
          requestTargetEmail === selectedTargetEmail;

        if (!matchesCurrentUser) continue;

        const baseSnapshot: UserDataSnapshot = currentSnapshot || startSnapshot;
        const nextSnapshot: UserDataSnapshot | null =
          request.type === 'INITIATE'
            ? UserDbController.extractUserSnapshot(request.data)
            : UserDbController.applyUserRequestSnapshot(baseSnapshot, request);
        if (!nextSnapshot) continue;

        if (request.id === selectedRequestId) {
          return {
            oldData: currentSnapshot ? cloneJson(currentSnapshot) : null,
            newData: nextSnapshot,
          };
        }

        currentSnapshot = nextSnapshot;
      }
    }

    return { oldData: null, newData: null };
  }

  private static rolePermissionRank(value: unknown) {
    return (
      {
        VIEWER: 1,
        USER: 2,
        MANAGER: 3,
      }[String(value || '').toUpperCase()] || 0
    );
  }

  private static accessScopeRank(value: unknown) {
    return (
      {
        NODE: 1,
        IMMEDIATE_CHILD: 2,
        ALL_CHILD: 3,
      }[String(value || 'NODE').toUpperCase()] || 1
    );
  }

  private static async fetchUserSnapshot(
    client: any,
    targetUserId: string,
    companyId: string,
  ): Promise<{
    user: any;
    mapping: any;
    snapshot: UserDataSnapshot;
  }> {
    const user = await client.user.findUnique({
      where: { id: targetUserId },
      include: {
        userMappings: {
          where: { companyId },
          include: { manager: true },
        },
        userAccesses: {
          where: { companyId },
          include: { role: true, orgStructure: true },
        },
      },
    });
    const mapping = user?.userMappings?.[0];

    if (!user || !mapping) {
      throw new AppError('User is not mapped to this company', 404);
    }

    return {
      user,
      mapping,
      snapshot: {
        basicDetails: {
          name: user.name,
          email: user.email,
          phone: user.phone,
          designation: mapping.designation || null,
          employeeId: mapping.employeeId || null,
          reportingManager: mapping.manager?.email || null,
          status: mapping.status,
        },
        permissions: user.userAccesses.map((access: any) => ({
          accessType: access.accessType || 'SECONDARY',
          roleName: access.role?.roleName || access.roleCode,
          roleCategory: access.role?.category || '',
          roleSubCategory: access.role?.subCategory || '',
          nodeName: access.orgStructure?.nodeName || '',
          nodePath: access.orgStructure?.nodePath || '',
          accessCategory: access.accessCategory || null,
        })),
      },
    };
  }

  private static async validateModificationPermission(
    initiatorId: string,
    companyId: string,
  ) {
    const access = await prisma.userAccess.findFirst({
      where: {
        userId: initiatorId,
        companyId,
        user: {
          userMappings: {
            some: { companyId, status: 'ACTIVE' },
          },
        },
        OR: [
          { roleCode: 'SAAS_ADMIN' },
          { isGlobalAccess: true },
          { role: { subCategory: 'USER_ACC', modify: true } },
        ],
      },
    });

    if (!access) {
      throw new AppError(
        'Access Denied: UPDATE permission is required for user modifications',
        403,
      );
    }
  }

  private static async validateChangedPermissions(
    companyId: string,
    permissions: any[],
  ) {
    for (const rawPermission of permissions) {
      const operation =
        rawPermission.remove === true
          ? 'REMOVE'
          : String(rawPermission.operation || '').toUpperCase();
      if (operation === 'REMOVE') continue;

      const [role, node] = await Promise.all([
        prisma.roles.findFirst({
          where: {
            roleName: rawPermission.roleName,
            category: rawPermission.roleCategory,
            subCategory: rawPermission.roleSubCategory,
            isActive: true,
          },
        }),
        prisma.orgStructure.findFirst({
          where: {
            companyId,
            nodePath: rawPermission.nodePath,
            nodeName: rawPermission.nodeName,
            status: 'ACTIVE',
          },
        }),
      ]);

      if (!role) {
        throw new AppError(`Role '${rawPermission.roleName}' not found`, 400);
      }
      if (!node) {
        throw new AppError(`Node '${rawPermission.nodePath}' not found`, 400);
      }
    }
  }

  private static async expandInitiatePermissionsForChildNodes(
    companyId: string,
    permissions: any[],
  ) {
    if (!Array.isArray(permissions) || permissions.length === 0) {
      return [];
    }

    const explicitPermissionKeys = new Set(
      permissions
        .filter((permission) => !UserDbController.isPermissionRemoval(permission))
        .map((permission) =>
          [
            permission?.roleName || '',
            permission?.nodePath || '',
          ].join('|'),
        ),
    );
    const expandedPermissions: any[] = [];
    const generatedPermissionKeys = new Set<string>();

    for (const permission of permissions) {
      expandedPermissions.push(permission);

      if (
        UserDbController.isPermissionRemoval(permission) ||
        permission?.roleName === 'Corp Admin' ||
        (permission?.accessCategory !== 'ALL_CHILD' &&
          permission?.accessCategory !== 'IMMEDIATE_CHILD') ||
        typeof permission?.nodePath !== 'string'
      ) {
        continue;
      }

      const children = await prisma.orgStructure.findMany({
        where: {
          companyId,
          status: 'ACTIVE',
          ...(permission.accessCategory === 'ALL_CHILD'
            ? { nodePath: { startsWith: `${permission.nodePath}.` } }
            : { parent: { nodePath: permission.nodePath } }),
        },
        select: {
          nodeName: true,
          nodePath: true,
          nodeType: true,
        },
        orderBy: { nodePath: 'asc' },
      });

      for (const child of children) {
        const permissionKey = [
          permission.roleName || '',
          child.nodePath || '',
        ].join('|');
        if (
          explicitPermissionKeys.has(permissionKey) ||
          generatedPermissionKeys.has(permissionKey)
        ) {
          continue;
        }

        generatedPermissionKeys.add(permissionKey);
        expandedPermissions.push({
          ...permission,
          accessType: 'SECONDARY',
          nodeName: child.nodeName,
          nodePath: child.nodePath,
          nodeType: child.nodeType,
          accessCategory:
            permission.accessCategory === 'IMMEDIATE_CHILD'
              ? 'NODE'
              : 'ALL_CHILD',
        });
      }
    }

    return expandedPermissions;
  }

  private static async validateReportingManagerChange(
    targetUserId: string,
    companyId: string,
    reportingManager: unknown,
  ) {
    if (reportingManager === undefined || reportingManager === null) return;

    const manager = await prisma.user.findUnique({
      where: { email: reportingManager as string },
      include: {
        userMappings: {
          where: { companyId, status: 'ACTIVE' },
        },
      },
    });

    if (!manager || manager.userMappings.length === 0) {
      throw new AppError(
        'Reporting manager must be active in the same company',
        400,
      );
    }
    if (manager.id === targetUserId) {
      throw new AppError('A user cannot report to themselves', 400);
    }

    let managerId: string | null = manager.id;
    const visited = new Set<string>();
    while (managerId && !visited.has(managerId)) {
      if (managerId === targetUserId) {
        throw new AppError('Reporting manager change creates a cycle', 400);
      }
      visited.add(managerId);
      const mapping: { reportingManager: string | null } | null =
        await prisma.userMapping.findUnique({
          where: { userId_companyId: { userId: managerId, companyId } },
          select: { reportingManager: true },
        });
      managerId = mapping?.reportingManager || null;
    }
  }

  private static async calculateModificationImpact(
    type: UserRequestType,
    existing: UserDataSnapshot,
    proposed: UserDataSnapshot,
    diff: UserPermissionDiff,
  ) {
    if (type === 'ARCHIVE') return 'ARCHIVE';
    if (type === 'INACTIVE') return 'INACTIVE';
    if (type === 'ACTIVE') return 'ACTIVE';

    const updatedRoles = diff.updated.flatMap((change) => [
      change.oldData.roleName,
      change.newData.roleName,
    ]);
    const roles =
      updatedRoles.length > 0
        ? await prisma.roles.findMany({
          where: { roleName: { in: updatedRoles } },
          select: { roleName: true, permissionLevel: true },
        })
        : [];
    const roleRank = new Map(
      roles.map((role) => [
        role.roleName,
        UserDbController.rolePermissionRank(role.permissionLevel),
      ]),
    );
    const hasLowerPermission = diff.updated.some((change) => {
      const oldRoleRank = roleRank.get(change.oldData.roleName) || 0;
      const newRoleRank = roleRank.get(change.newData.roleName) || 0;
      const oldScopeRank = UserDbController.accessScopeRank(
        change.oldData.accessCategory,
      );
      const newScopeRank = UserDbController.accessScopeRank(
        change.newData.accessCategory,
      );

      return newRoleRank < oldRoleRank || newScopeRank < oldScopeRank;
    });
    const hasHigherPermission = diff.updated.some((change) => {
      const oldRoleRank = roleRank.get(change.oldData.roleName) || 0;
      const newRoleRank = roleRank.get(change.newData.roleName) || 0;
      const oldScopeRank = UserDbController.accessScopeRank(
        change.oldData.accessCategory,
      );
      const newScopeRank = UserDbController.accessScopeRank(
        change.newData.accessCategory,
      );

      return newRoleRank > oldRoleRank || newScopeRank > oldScopeRank;
    });

    if (diff.removed.length > 0 || hasLowerPermission) return 'DOWNGRADE';
    if (diff.added.length > 0 || hasHigherPermission) return 'UPGRADE';
    if (
      existing.basicDetails.reportingManager !==
      proposed.basicDetails.reportingManager
    ) {
      return 'RMUPDATED';
    }

    return 'PROFILE_UPDATE';
  }

  private static normalizeFilterText(value: unknown) {
    if (typeof value !== 'string') return null;

    const normalized = value.trim();
    return normalized || null;
  }

  private static addTextFilterOption(
    optionMap: Map<string, TextFilterOption>,
    value: unknown,
  ) {
    const normalizedValue = UserDbController.normalizeFilterText(value);
    if (!normalizedValue) return;

    const key = normalizedValue.toLowerCase();
    if (!optionMap.has(key)) {
      optionMap.set(key, {
        label: normalizedValue,
        value: normalizedValue,
      });
    }
  }

  private static addNodeFilterOption(
    optionMap: Map<string, NodeFilterOption>,
    node: {
      nodeName?: unknown;
      nodePath?: unknown;
      nodeType?: unknown;
    } | null,
  ) {
    if (!node) return null;

    const nodePath = UserDbController.normalizeFilterText(node.nodePath);
    if (!nodePath) return null;

    const nodeName =
      UserDbController.normalizeFilterText(node.nodeName) || nodePath;
    const nodeType = UserDbController.normalizeFilterText(node.nodeType);
    const key = nodePath.toLowerCase();

    if (!optionMap.has(key)) {
      optionMap.set(key, {
        label: nodeName,
        value: nodePath,
        nodeName,
        nodePath,
        nodeType,
      });
    }

    return optionMap.get(key) || null;
  }

  private static addDepartmentFilterOption(
    optionMap: Map<string, NodeFilterOption>,
    node: {
      nodeName?: unknown;
      nodePath?: unknown;
      nodeType?: unknown;
    } | null,
  ) {
    if (!node) return;

    const nodeName = UserDbController.normalizeFilterText(node.nodeName);
    if (!nodeName) return;

    const nodePath =
      UserDbController.normalizeFilterText(node.nodePath) || nodeName;
    const nodeType = UserDbController.normalizeFilterText(node.nodeType);
    const key = nodeName.toLowerCase();

    if (!optionMap.has(key)) {
      optionMap.set(key, {
        label: nodeName,
        value: nodeName,
        nodeName,
        nodePath,
        nodeType,
      });
    }
  }

  private static addManagerFilterOption(
    optionMap: Map<string, ManagerFilterOption>,
    manager: {
      id?: unknown;
      name?: unknown;
      email?: unknown;
    } | null,
  ) {
    if (!manager) return;

    const email = UserDbController.normalizeFilterText(manager.email);
    if (!email) return;

    const name = UserDbController.normalizeFilterText(manager.name);
    const id = UserDbController.normalizeFilterText(manager.id);
    const key = email.toLowerCase();

    if (!optionMap.has(key)) {
      optionMap.set(key, {
        label: name ? `${name} - ${email}` : email,
        value: email,
        id,
        name,
        email,
      });
    }
  }

  private static sortFilterOptions<T extends { label: string }>(
    optionMap: Map<string, T>,
  ) {
    return Array.from(optionMap.values()).sort((a, b) =>
      a.label.localeCompare(b.label),
    );
  }

  private static async fetchDefaultWorkflowOption(
    companyId: string,
    subCategory: unknown,
  ): Promise<CompanyNodeWorkflowOption | null> {
    const normalizedSubCategory =
      UserDbController.normalizeFilterText(subCategory);
    if (!normalizedSubCategory) return null;

    return prisma.workflow.findFirst({
      where: {
        companyId,
        module: 'SYSTEM_ACCESS',
        subModule: normalizedSubCategory,
        name: { contains: 'DEFAULT' },
        status: 'ACTIVE',
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        levelsHash: true,
        name: true,
        alias: true,
        status: true,
        module: true,
        subModule: true,
        orgStructure: {
          select: { nodePath: true },
        },
      },
    }).then((workflow) =>
      workflow
        ? {
          ...workflow,
          nodePath: workflow.orgStructure?.nodePath,
        }
        : null,
    );
  }

  private static withDefaultWorkflowOption<
    T extends { workflows?: CompanyNodeWorkflowOption[] | null },
  >(node: T, defaultWorkflow: CompanyNodeWorkflowOption | null) {
    const workflows = node.workflows || [];

    return {
      ...node,
      workflows:
        workflows.length > 0 || !defaultWorkflow
          ? workflows
          : [defaultWorkflow],
    };
  }

  private static workflowIdentityKey(target: {
    module?: string | null;
    subModule?: string | null;
    nodePath?: string | null;
    levelsHash?: string | null;
  }) {
    if (
      !target.module ||
      !target.subModule ||
      !target.nodePath ||
      !target.levelsHash
    ) {
      return null;
    }

    return [
      target.module,
      target.subModule,
      target.nodePath,
      target.levelsHash,
    ].join('|');
  }

  private static extractWorkflowRequestTarget(request: any) {
    const data = request?.data as any;
    const target = data?.target || {};
    const currentData = data?.currentData || {};
    const newData = data?.newData || {};
    const oldData = data?.oldData || {};
    const nodePath =
      target?.nodePath ||
      data?.nodePath ||
      data?.orgStructure?.nodePath ||
      currentData?.nodePath ||
      currentData?.orgStructure?.nodePath ||
      newData?.nodePath ||
      newData?.orgStructure?.nodePath ||
      oldData?.nodePath ||
      oldData?.orgStructure?.nodePath ||
      null;
    const module =
      target?.module ||
      data?.module ||
      currentData?.module ||
      newData?.module ||
      oldData?.module ||
      request?.module ||
      null;
    const subModule =
      target?.subModule ||
      data?.subModule ||
      currentData?.subModule ||
      newData?.subModule ||
      oldData?.subModule ||
      request?.subModule ||
      null;
    const levelsHash =
      target?.levelsHash ||
      data?.levelsHash ||
      currentData?.levelsHash ||
      newData?.levelsHash ||
      oldData?.levelsHash ||
      request?.levelsHash ||
      null;

    if (!module || !subModule || !nodePath || !levelsHash) {
      return null;
    }

    return { module, subModule, nodePath, levelsHash };
  }

  private static async getAutoGeneratedWorkflowParentMap(companyId: string) {
    const rows = await prisma.workflowReq.findMany({
      where: {
        companyId,
        type: 'AUTO_GENERATE',
        status: 'APPROVED',
        workflowId: { not: null },
      },
      select: {
        workflowId: true,
        data: true,
      },
    });

    const parentByWorkflowId = new Map<string, string>();
    rows.forEach((request: any) => {
      const parentId = request.data?.sourceWorkflowId;
      if (
        typeof request.workflowId === 'string' &&
        request.workflowId &&
        typeof parentId === 'string' &&
        parentId
      ) {
        parentByWorkflowId.set(request.workflowId, parentId);
      }
    });

    return parentByWorkflowId;
  }

  private static collectWorkflowDescendantIds(
    parentByWorkflowId: Map<string, string>,
    rootWorkflowId: string,
  ) {
    const childrenByParentId = new Map<string, string[]>();
    parentByWorkflowId.forEach((parentId, workflowId) => {
      const children = childrenByParentId.get(parentId) || [];
      children.push(workflowId);
      childrenByParentId.set(parentId, children);
    });

    const descendants: string[] = [];
    const visited = new Set<string>([rootWorkflowId]);
    const queue = [...(childrenByParentId.get(rootWorkflowId) || [])];

    while (queue.length > 0) {
      const workflowId = queue.shift()!;
      if (visited.has(workflowId)) continue;
      visited.add(workflowId);
      descendants.push(workflowId);
      queue.push(...(childrenByParentId.get(workflowId) || []));
    }

    return descendants;
  }

  private static extractOrgRequestTargetPath(request: any) {
    const data = request?.data as any;
    return (
      data?.targetNodePath ||
      data?.currentData?.nodePath ||
      data?.nodePath ||
      null
    );
  }

  private static async getPendingOrgNodePathsForFetch(companyId: string) {
    const pendingRequests = await prisma.orgStructureReq.findMany({
      where: {
        companyId,
        status: 'PENDING',
        type: { in: ['UPDATE', 'INACTIVE', 'ARCHIVE'] },
      },
      select: { id: true, data: true },
    });
    const effectiveIds = await UserDbController.filterEffectivelyPendingRequestIds(
      'org_structure_req',
      pendingRequests.map((request) => request.id),
    );

    return new Set(
      pendingRequests
        .filter((request) => effectiveIds.has(request.id))
        .map((request) => UserDbController.extractOrgRequestTargetPath(request))
        .filter((nodePath): nodePath is string => typeof nodePath === 'string'),
    );
  }

  private static async getPendingWorkflowKeysForFetch(companyId: string) {
    const activeWorkflows = await prisma.workflow.findMany({
      where: { companyId, status: 'ACTIVE' },
      select: {
        id: true,
        module: true,
        subModule: true,
        levelsHash: true,
        orgStructure: { select: { nodePath: true, status: true } },
      },
    });
    const activeWorkflowKeyById = new Map(
      activeWorkflows
        .map((workflow) => [
          workflow.id,
          UserDbController.workflowIdentityKey({
            module: workflow.module,
            subModule: workflow.subModule,
            nodePath: workflow.orgStructure?.nodePath,
            levelsHash: workflow.levelsHash,
          }),
        ])
        .filter((entry): entry is [string, string] => Boolean(entry[1])),
    );
    const activeWorkflowIdByKey = new Map(
      Array.from(activeWorkflowKeyById.entries()).map(([id, key]) => [
        key,
        id,
      ]),
    );
    const autoGeneratedParentByWorkflowId =
      await UserDbController.getAutoGeneratedWorkflowParentMap(companyId);
    const pendingKeys = new Set<string>();
    const addPendingWorkflowFamilyKeys = (workflowId: string | null | undefined) => {
      if (!workflowId) return;
      [
        workflowId,
        ...UserDbController.collectWorkflowDescendantIds(
          autoGeneratedParentByWorkflowId,
          workflowId,
        ),
      ].forEach((relatedWorkflowId) => {
        const workflowKey = activeWorkflowKeyById.get(relatedWorkflowId);
        if (workflowKey) {
          pendingKeys.add(workflowKey);
        }
      });
    };

    const pendingRequests = await prisma.workflowReq.findMany({
      where: {
        companyId,
        status: 'PENDING',
        type: { in: ['INITIATE', 'UPDATE', 'INACTIVE', 'ARCHIVE'] },
      },
      select: {
        id: true,
        nodeId: true,
        workflowId: true,
        module: true,
        subModule: true,
        levelsHash: true,
        data: true,
      },
    });
    const pendingNodeIds = Array.from(
      new Set(
        pendingRequests
          .map((request) => request.nodeId)
          .filter((nodeId): nodeId is string => typeof nodeId === 'string' && Boolean(nodeId)),
      ),
    );
    const pendingNodes =
      pendingNodeIds.length > 0
        ? await prisma.orgStructure.findMany({
          where: {
            companyId,
            id: { in: pendingNodeIds },
          },
          select: {
            id: true,
            nodePath: true,
          },
        })
        : [];
    const pendingNodePathById = new Map(
      pendingNodes.map((node) => [node.id, node.nodePath]),
    );
    const effectiveIds = await UserDbController.filterEffectivelyPendingRequestIds(
      'workflow_req',
      pendingRequests.map((request) => request.id),
    );

    pendingRequests
      .filter((request) => effectiveIds.has(request.id))
      .forEach((request) => {
        const target = UserDbController.extractWorkflowRequestTarget(request);
        let targetKey = target
          ? UserDbController.workflowIdentityKey(target)
          : null;
        let targetWorkflowId = targetKey
          ? activeWorkflowIdByKey.get(targetKey)
          : null;
        if (!targetKey && request.nodeId) {
          targetKey = UserDbController.workflowIdentityKey({
            module: request.module,
            subModule: request.subModule,
            nodePath: pendingNodePathById.get(request.nodeId) || null,
            levelsHash: request.levelsHash,
          });
          targetWorkflowId = targetKey
            ? activeWorkflowIdByKey.get(targetKey)
            : null;
        }
        if (targetKey) {
          pendingKeys.add(targetKey);
          addPendingWorkflowFamilyKeys(targetWorkflowId);
          return;
        }

        addPendingWorkflowFamilyKeys(request.workflowId);
      });

    return pendingKeys;
  }

  private static normalizePageDirection(value: unknown): 'next' | 'prev' {
    return typeof value === 'string' &&
      ['prev', 'previous'].includes(value.trim().toLowerCase())
      ? 'prev'
      : 'next';
  }

  private static encodeCursor(row?: { id: string; createdAt: Date } | null) {
    if (!row) return null;

    return Buffer.from(
      JSON.stringify({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
      }),
    ).toString('base64url');
  }

  private static decodeCursor(value: unknown) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') return null;

    const normalizedValue = value.trim();
    if (
      !normalizedValue ||
      ['null', 'undefined'].includes(normalizedValue.toLowerCase())
    ) {
      return null;
    }

    try {
      const payload = JSON.parse(
        Buffer.from(normalizedValue, 'base64url').toString('utf8'),
      );
      const createdAt = new Date(payload.createdAt);
      if (
        typeof payload.id !== 'string' ||
        !payload.id ||
        Number.isNaN(createdAt.getTime())
      ) {
        throw new Error('Invalid cursor payload');
      }

      return { id: payload.id, createdAt };
    } catch {
      throw new AppError('Invalid pagination cursor', 400);
    }
  }

  private static appendCursorWhere(
    where: any,
    cursor: { id: string; createdAt: Date } | null,
    direction: 'older' | 'newer',
  ) {
    if (!cursor) return where;

    const createdAtOperator = direction === 'older' ? 'lt' : 'gt';
    const idOperator = direction === 'older' ? 'lt' : 'gt';

    return {
      AND: [
        where,
        {
          OR: [
            { createdAt: { [createdAtOperator]: cursor.createdAt } },
            {
              createdAt: cursor.createdAt,
              id: { [idOperator]: cursor.id },
            },
          ],
        },
      ],
    };
  }

  private static buildPageInfo(
    rows: Array<{ id: string; createdAt: Date }>,
    limit: number,
    requestedTopCursor: string | null,
    newCount: number,
    direction: 'next' | 'prev',
    cursor: { id: string; createdAt: Date } | null,
    page: number,
    isPagePagination = false,
  ) {
    const hasExtra = rows.length > limit;
    const limitedRows = hasExtra ? rows.slice(0, limit) : rows;
    const pageRows =
      direction === 'prev' ? [...limitedRows].reverse() : limitedRows;
    const firstRow = pageRows[0] || null;
    const lastRow = pageRows[pageRows.length - 1] || null;
    const hasNext = direction === 'prev' ? !!cursor : hasExtra;
    const hasPrev = isPagePagination
      ? page > 1
      : direction === 'prev'
        ? hasExtra
        : !!cursor;

    return {
      pageRows,
      pageInfo: {
        page,
        nextCursor: hasNext ? UserDbController.encodeCursor(lastRow) : null,
        prevCursor: hasPrev ? UserDbController.encodeCursor(firstRow) : null,
        topCursor:
          requestedTopCursor || UserDbController.encodeCursor(firstRow),
        hasNext,
        hasPrev,
        hasNewData: newCount > 0,
        newCount,
      },
    };
  }

  private static isRowInCursorDirection(
    row: { id: string; createdAt: Date },
    cursor: { id: string; createdAt: Date },
    direction: 'older' | 'newer',
  ) {
    const rowTime = row.createdAt.getTime();
    const cursorTime = cursor.createdAt.getTime();

    if (direction === 'older') {
      return (
        rowTime < cursorTime || (rowTime === cursorTime && row.id < cursor.id)
      );
    }

    return (
      rowTime > cursorTime || (rowTime === cursorTime && row.id > cursor.id)
    );
  }

  private static getPageOrder(direction: 'next' | 'prev'): any[] {
    return direction === 'prev'
      ? [{ createdAt: 'asc' }, { id: 'asc' }]
      : [{ createdAt: 'desc' }, { id: 'desc' }];
  }

  private static async getCurrentApproverRequestIds(
    reqTable: string,
    userId?: string | null,
    companyId?: string | null,
  ) {
    if (!userId) return [];

    const approverRows = await prisma.workflowApprover.findMany({
      where: { reqTable, status: 'PENDING' },
      select: { reqId: true, approversList: true },
    });

    const approverReqIds = approverRows
      .filter(
        (row) =>
          Array.isArray(row.approversList) &&
          row.approversList.includes(userId),
      )
      .map((row) => row.reqId);

    if (!companyId || reqTable !== 'user_onboarding') {
      return approverReqIds;
    }

    const initiatedReqIds = (
      await prisma.userOnboarding.findMany({
        where: {
          companyId,
          status: 'PENDING',
          initiatorId: userId,
        },
        select: { id: true },
      })
    ).map((row) => row.id);

    return Array.from(new Set([...approverReqIds, ...initiatedReqIds]));
  }

  private static async filterEffectivelyPendingRequestIds(
    reqTable: string,
    requestIds: string[],
  ) {
    if (requestIds.length === 0) return new Set<string>();
    const approverRows = await prisma.workflowApprover.findMany({
      where: { reqTable, reqId: { in: requestIds } },
      select: { reqId: true, status: true },
    });
    const summary = new Map<string, { total: number; pending: number }>();
    requestIds.forEach((id) => summary.set(id, { total: 0, pending: 0 }));
    approverRows.forEach((row) => {
      const current = summary.get(row.reqId) || { total: 0, pending: 0 };
      current.total += 1;
      if (row.status === 'PENDING') current.pending += 1;
      summary.set(row.reqId, current);
    });

    const noApproverIds = Array.from(summary.entries())
      .filter(([, value]) => value.total === 0)
      .map(([id]) => id);
    const latestHistoryByReqId = new Map<string, string>();
    if (noApproverIds.length > 0) {
      const historyRows =
        reqTable === 'workflow_req'
          ? await prisma.workflowReqHistory.findMany({
            where: { workflowReqId: { in: noApproverIds } },
            orderBy: [{ createdAt: 'desc' }],
            select: { workflowReqId: true, event: true },
          })
          : reqTable === 'org_structure_req'
            ? await prisma.orgHistory.findMany({
              where: { orgReqId: { in: noApproverIds } },
              orderBy: [{ createdAt: 'desc' }],
              select: { orgReqId: true, event: true },
            })
            : await prisma.userHistory.findMany({
              where: { reqId: { in: noApproverIds } },
              orderBy: [{ createdAt: 'desc' }],
              select: { reqId: true, event: true },
            });

      historyRows.forEach((row: any) => {
        const reqId = row.workflowReqId || row.orgReqId || row.reqId;
        if (reqId && !latestHistoryByReqId.has(reqId)) {
          latestHistoryByReqId.set(reqId, row.event);
        }
      });
    }

    const effective = new Set<string>();
    summary.forEach((value, id) => {
      const latestEvent = latestHistoryByReqId.get(id);
      const noApproverButStillOpen =
        value.total === 0 &&
        latestEvent !== 'APPROVED' &&
        latestEvent !== 'REJECTED';
      if (noApproverButStillOpen || value.pending > 0) {
        effective.add(id);
      }
    });
    return effective;
  }

  private static async assertNoPendingOrgModificationForNode(
    companyId: string,
    nodePath: string,
  ) {
    const pendingOrgRequests = await prisma.orgStructureReq.findMany({
      where: {
        companyId,
        status: 'PENDING',
        type: 'UPDATE',
      },
      include: {
        orgHistories: {
          where: { event: 'INITIATE' },
          orderBy: { createdAt: 'asc' },
          include: { user: true },
        },
      },
    });
    const effectiveIds = await UserDbController.filterEffectivelyPendingRequestIds(
      'org_structure_req',
      pendingOrgRequests.map((request) => request.id),
    );
    const effectivePendingOrgRequests = pendingOrgRequests.filter((request) =>
      effectiveIds.has(request.id),
    );

    const blocking = effectivePendingOrgRequests.find((request) => {
      const data = request.data as any;
      const targetNodePath =
        data?.targetNodePath || data?.currentData?.nodePath || data?.nodePath;
      return (
        typeof targetNodePath === 'string' &&
        targetNodePath === nodePath
      );
    });

    if (!blocking) return;
    const data = blocking.data as any;
    const initiatorHistory = blocking.orgHistories?.[0];
    const targetNodePath =
      data?.targetNodePath || data?.currentData?.nodePath || data?.nodePath;
    throw new AppError(
      `User initiation is blocked because organization node '${targetNodePath}' has a pending inactivation request initiated by ${initiatorHistory?.user?.name || 'Unknown'} - ${initiatorHistory?.user?.email || 'unknown'} on ${UserDbController.formatConflictDate(initiatorHistory?.createdAt || blocking.createdAt)}. Resolve the organization request first.`,
      400,
    );
  }

  private static async assertNoPendingWorkflowModificationForNode(
    companyId: string,
    nodePath: string,
    levelsHash?: string | null,
  ) {
    if (!levelsHash) return;

    const selectedWorkflow = await prisma.workflow.findFirst({
      where: {
        companyId,
        module: 'SYSTEM_ACCESS',
        subModule: 'USER_ACC',
        status: 'ACTIVE',
        levelsHash,
        orgStructure: { nodePath },
      },
      include: { orgStructure: { select: { nodePath: true } } },
    });
    if (!selectedWorkflow) return;

    const pendingWorkflowRequests = await prisma.workflowReq.findMany({
      where: {
        companyId,
        status: 'PENDING',
        type: { in: ['UPDATE', 'INACTIVE'] },
      },
      include: {
        workflowHistories: {
          where: { event: 'INITIATE' },
          orderBy: { createdAt: 'asc' },
          include: { user: true },
        },
      },
    });
    const effectiveIds = await UserDbController.filterEffectivelyPendingRequestIds(
      'workflow_req',
      pendingWorkflowRequests.map((request) => request.id),
    );
    const effectivePendingWorkflowRequests = pendingWorkflowRequests.filter(
      (request) => effectiveIds.has(request.id),
    );

    const blocking = effectivePendingWorkflowRequests.find((request) => {
      const data = request.data as any;
      const target = data?.target || {};
      const targetNodePath = target?.nodePath || data?.nodePath;
      const targetModule = target?.module || data?.module || request.module;
      const targetSubModule =
        target?.subModule || data?.subModule || request.subModule;
      const targetLevelsHash =
        target?.levelsHash || data?.levelsHash || request.levelsHash;

      if (
        targetModule !== 'SYSTEM_ACCESS' ||
        targetSubModule !== 'USER_ACC' ||
        typeof targetNodePath !== 'string'
      ) {
        return false;
      }

      return (
        targetNodePath === selectedWorkflow.orgStructure?.nodePath &&
        targetLevelsHash === selectedWorkflow.levelsHash
      );
    });

    if (!blocking) return;
    const data = blocking.data as any;
    const target = data?.target || {};
    const history = blocking.workflowHistories?.[0];
    const workflowName =
      data?.name || target?.levelsHash || blocking.levelsHash || blocking.id;
    throw new AppError(
      `User initiation is blocked because workflow '${workflowName}' has a pending ${blocking.type} request initiated by ${history?.user?.name || 'Unknown'} - ${history?.user?.email || 'unknown'} on ${UserDbController.formatConflictDate(history?.createdAt || blocking.createdAt)}. Resolve the workflow request first.`,
      400,
    );
  }

  private static async assertSelectedApprovalWorkflowNotPendingModification(
    companyId: string,
    levelsHash?: string | null,
  ) {
    // When no workflow is explicitly selected, do not apply the selected-workflow
    // conflict check. This guard should only protect the workflow the user chose.
    if (!levelsHash) return;

    const selectedWorkflow = await prisma.workflow.findFirst({
      where: {
        companyId,
        module: 'SYSTEM_ACCESS',
        subModule: 'USER_ACC',
        status: 'ACTIVE',
        levelsHash,
      },
      include: { orgStructure: { select: { nodePath: true } } },
    });
    if (!selectedWorkflow) return;

    const pendingModifications = await prisma.workflowReq.findMany({
      where: {
        companyId,
        status: 'PENDING',
        type: { in: ['UPDATE', 'INACTIVE'] },
      },
      include: {
        workflowHistories: {
          where: { event: 'INITIATE' },
          orderBy: { createdAt: 'asc' },
          include: { user: true },
        },
      },
    });
    const effectiveIds = await UserDbController.filterEffectivelyPendingRequestIds(
      'workflow_req',
      pendingModifications.map((request) => request.id),
    );
    const pendingModification = pendingModifications.find((request: any) => {
      if (!effectiveIds.has(request.id)) return false;
      const target = (request.data as any)?.target || {};
      return (
        target?.module === selectedWorkflow.module &&
        target?.subModule === selectedWorkflow.subModule &&
        target?.nodePath === selectedWorkflow.orgStructure?.nodePath &&
        target?.levelsHash === selectedWorkflow.levelsHash
      );
    });
    if (!pendingModification) return;

    const h = pendingModification.workflowHistories?.[0];
    throw new AppError(
      `Selected approval workflow '${selectedWorkflow.name}' has a pending ${pendingModification.type} request initiated by ${h?.user?.name || 'Unknown'} - ${h?.user?.email || 'unknown'} on ${UserDbController.formatConflictDate(h?.createdAt || pendingModification.createdAt)}. Please resolve that workflow request first.`,
      409,
    );
  }

  private static formatProductionUser(u: any, pendingRequest?: any) {
    const mapping = u.userMappings[0];

    return {
      isPending: Boolean(pendingRequest),
      basicDetails: {
        name: u.name,
        email: u.email,
        phone: u.phone,
        createdAt: u.createdAt,
        designation: mapping?.designation || null,
        employeeId: mapping?.employeeId || null,
        reportingManagerName: mapping?.manager?.name || null,
        reportingManagerEmail: mapping?.manager?.email || null,
      },
      primary: u.userAccesses
        .filter((a: any) => a.accessType === 'PRIMARY' || a.isGlobalAccess)
        .map((a: any) => ({
          roleCategory: a.role?.category,
          roleSubCategory: a.role?.subCategory,
          roleName: a.role?.roleName,
          nodeName: a.orgStructure?.nodeName,
          nodePath: a.orgStructure?.nodePath,
          nodeType: a.orgStructure?.nodeType,
          accessCategory: a.accessCategory,
        })),
      secondary: u.userAccesses
        .filter((a: any) => a.accessType === 'SECONDARY' && !a.isGlobalAccess)
        .map((a: any) => ({
          roleCategory: a.role?.category,
          roleSubCategory: a.role?.subCategory,
          roleName: a.role?.roleName,
          nodeName: a.orgStructure?.nodeName,
          nodePath: a.orgStructure?.nodePath,
          nodeType: a.orgStructure?.nodeType,
          accessCategory: a.accessCategory,
        })),
    };
  }

  private static matchesPendingUserSearch(
    onboarding: any,
    query: string | null,
  ) {
    if (!query) return true;

    const basicDetails = (onboarding.data as any)?.basicDetails || {};
    const normalizedQuery = query.toLowerCase();

    return [
      basicDetails.name,
      basicDetails.email,
      basicDetails.designation,
      basicDetails.phone,
    ].some(
      (value) =>
        typeof value === 'string' &&
        value.toLowerCase().includes(normalizedQuery),
    );
  }

  private static async fetchPendingUserOnboardings(params: {
    resolvedCompanyId: string;
    isGlobal: boolean;
    visibleNodePaths: string[];
    offset: number;
    limit: number;
    applyPagination: boolean;
    page: number;
    isPagePagination?: boolean;
    cursor?: { id: string; createdAt: Date } | null;
    topCursor?: { id: string; createdAt: Date } | null;
    requestedTopCursor?: string | null;
    direction?: 'next' | 'prev';
    query?: string | null;
    viewerUserId?: string | null;
  }) {
    const {
      resolvedCompanyId,
      isGlobal,
      visibleNodePaths,
      offset,
      limit,
      applyPagination,
      page,
      isPagePagination = false,
      cursor = null,
      topCursor = null,
      requestedTopCursor = null,
      direction = 'next',
      query = null,
      viewerUserId = null,
    } = params;
    const effectiveDirection = cursor ? direction : 'next';
    const approverRequestIds =
      await UserDbController.getCurrentApproverRequestIds(
        'user_onboarding',
        viewerUserId,
        resolvedCompanyId,
      );
    const pendingVisibleWhere = { id: { in: approverRequestIds } };

    if (isGlobal && !query) {
      const where = {
        status: 'PENDING' as const,
        companyId: resolvedCompanyId,
        ...pendingVisibleWhere,
      };
      const pageWhere =
        applyPagination && cursor
          ? UserDbController.appendCursorWhere(
            where,
            cursor,
            effectiveDirection === 'prev' ? 'newer' : 'older',
          )
          : where;
      const newWhere =
        applyPagination && topCursor
          ? UserDbController.appendCursorWhere(where, topCursor, 'newer')
          : null;

      const [pendingCount, pendingOnboardings, newCount] = await Promise.all([
        prisma.userOnboarding.count({ where }),
        prisma.userOnboarding.findMany({
          where: pageWhere,
          orderBy: UserDbController.getPageOrder(effectiveDirection),
          ...(applyPagination
            ? { skip: cursor ? 0 : offset, take: limit + 1 }
            : {}),
        }),
        newWhere
          ? prisma.userOnboarding.count({ where: newWhere })
          : Promise.resolve(0),
      ]);

      if (!applyPagination) {
        return { pendingCount, pendingOnboardings };
      }

      const { pageRows, pageInfo } = UserDbController.buildPageInfo(
        pendingOnboardings,
        limit,
        requestedTopCursor,
        newCount,
        effectiveDirection,
        cursor,
        page,
        isPagePagination,
      );
      const firstPageRow = pageRows[0];
      if (!isPagePagination && cursor && firstPageRow) {
        const newerCount = await prisma.userOnboarding.count({
          where: UserDbController.appendCursorWhere(
            where,
            firstPageRow,
            'newer',
          ),
        });
        pageInfo.page = Math.floor(newerCount / limit) + 1;
      }

      return { pendingCount, pendingOnboardings: pageRows, pageInfo };
    }

    if (
      !isGlobal &&
      visibleNodePaths.length === 0 &&
      approverRequestIds.length === 0
    ) {
      return {
        pendingCount: 0,
        pendingOnboardings: [],
        pageInfo: {
          nextCursor: null,
          prevCursor: null,
          topCursor: requestedTopCursor,
          page,
          hasNext: false,
          hasPrev: false,
          hasNewData: false,
          newCount: 0,
        },
      };
    }

    const approverRequestIdSet = new Set(approverRequestIds);

    const where = {
      status: 'PENDING' as const,
      companyId: resolvedCompanyId,
      ...pendingVisibleWhere,
    };

    const allPendingOnboardings = await prisma.userOnboarding.findMany({
      where,
      orderBy: UserDbController.getPageOrder(effectiveDirection),
    });

    const visiblePendingOnboardings = allPendingOnboardings.filter(
      (onb) =>
        approverRequestIdSet.has(onb.id) &&
        UserDbController.matchesPendingUserSearch(onb, query),
    );
    const pendingCount = visiblePendingOnboardings.length;
    const newCount =
      applyPagination && topCursor
        ? visiblePendingOnboardings.filter((onb) =>
          UserDbController.isRowInCursorDirection(onb, topCursor, 'newer'),
        ).length
        : 0;
    const pendingOnboardings = applyPagination
      ? visiblePendingOnboardings
        .filter((onb) =>
          cursor
            ? UserDbController.isRowInCursorDirection(
              onb,
              cursor,
              effectiveDirection === 'prev' ? 'newer' : 'older',
            )
            : true,
        )
        .slice(cursor ? 0 : offset, (cursor ? 0 : offset) + limit + 1)
      : visiblePendingOnboardings;

    if (!applyPagination) {
      return {
        pendingCount,
        pendingOnboardings,
      };
    }

    const { pageRows, pageInfo } = UserDbController.buildPageInfo(
      pendingOnboardings,
      limit,
      requestedTopCursor,
      newCount,
      effectiveDirection,
      cursor,
      page,
      isPagePagination,
    );
    const firstPageRow = pageRows[0];
    if (!isPagePagination && cursor && firstPageRow) {
      const newerCount = visiblePendingOnboardings.filter((onb) =>
        UserDbController.isRowInCursorDirection(onb, firstPageRow, 'newer'),
      ).length;
      pageInfo.page = Math.floor(newerCount / limit) + 1;
    }

    return {
      pendingCount,
      pendingOnboardings: pageRows,
      pageInfo,
    };
  }

  private static async formatPendingUsers(
    pendingOnboardings: any[],
    resolvedCompanyId: string,
  ) {
    const pendingEmails = pendingOnboardings
      .map((onb: any) => {
        const data = onb.data as any;
        return data?.targetUserEmail || data?.basicDetails?.email;
      })
      .filter(Boolean);

    const histories =
      pendingEmails.length > 0
        ? await prisma.userHistory.findMany({
          where: {
            email: { in: pendingEmails },
            companyId: resolvedCompanyId,
          },
          include: {
            user: { select: { name: true, email: true } },
          },
          orderBy: { createdAt: 'desc' },
        })
        : [];

    const historyMap = new Map();
    histories.forEach((h) => {
      const key = `${h.email}_${h.event}`;
      if (!historyMap.has(key)) {
        historyMap.set(key, h);
      }
    });

    const managerEmails = pendingOnboardings
      .map((onb: any) => (onb.data as any)?.basicDetails?.reportingManager)
      .filter(Boolean);

    const managers =
      managerEmails.length > 0
        ? await prisma.user.findMany({
          where: {
            email: { in: managerEmails },
          },
          select: { name: true, email: true },
        })
        : [];

    const managerMap = new Map();
    managers.forEach((m) => managerMap.set(m.email, m));

    const workflowIds = Array.from(
      new Set(
        pendingOnboardings.map((onb: any) => onb.workflowId).filter(Boolean),
      ),
    ) as string[];
    const workflowDetails =
      workflowIds.length > 0
        ? await prisma.workflow.findMany({
          where: { id: { in: workflowIds } },
          select: { id: true, name: true, alias: true },
        })
        : [];
    const workflowMap = new Map(workflowDetails.map((w) => [w.id, w]));

    const existingUsers =
      pendingEmails.length > 0
        ? await prisma.user.findMany({
          where: { email: { in: pendingEmails } },
          include: {
            userMappings: {
              where: { companyId: resolvedCompanyId },
              include: {
                manager: {
                  select: {
                    name: true,
                    email: true,
                  },
                },
              },
            },
            userAccesses: {
              where: { companyId: resolvedCompanyId },
              include: {
                role: {
                  select: {
                    roleName: true,
                    category: true,
                    subCategory: true,
                  },
                },
                orgStructure: {
                  select: {
                    nodeName: true,
                    nodePath: true,
                    nodeType: true,
                    status: true,
                  },
                },
              },
            },
          },
        })
        : [];
    const existingUserMap = new Map(
      existingUsers.map((user) => [String(user.email || '').toLowerCase(), user]),
    );
    const incomingNodePaths = Array.from(
      new Set(
        pendingOnboardings
          .flatMap((onb: any) => {
            const permissions = (onb.data as any)?.permissions;
            return Array.isArray(permissions)
              ? permissions.map((permission: any) => permission?.nodePath)
              : [];
          })
          .filter(
            (nodePath: any): nodePath is string =>
              typeof nodePath === 'string' && nodePath.trim().length > 0,
          ),
      ),
    );
    const activeIncomingNodes =
      incomingNodePaths.length > 0
        ? await prisma.orgStructure.findMany({
          where: {
            companyId: resolvedCompanyId,
            status: 'ACTIVE',
            nodePath: { in: incomingNodePaths },
          },
          select: { nodePath: true },
        })
        : [];
    const activeIncomingNodePaths = new Set(
      activeIncomingNodes.map((node) => node.nodePath),
    );
    const hasActivePermissionNode = (permission: any) =>
      typeof permission?.nodePath !== 'string' ||
      activeIncomingNodePaths.has(permission.nodePath);

    return pendingOnboardings.map((onb: any) => {
      const dataBlob = onb.data as any;
      const basic = dataBlob?.basicDetails || {};
      const email = basic.email || dataBlob?.targetUserEmail;
      const historyEmail = dataBlob?.targetUserEmail || email;
      const existingUser = existingUserMap.get(
        String(historyEmail || '').toLowerCase(),
      );
      const existingMapping = existingUser?.userMappings?.[0];
      const managerEmail = basic.reportingManager;
      const init = historyMap.get(`${historyEmail}_INITIATE`);
      const approve = historyMap.get(`${historyEmail}_APPROVED`);
      const managerInfo = managerMap.get(managerEmail);
      const w = onb.workflowId ? workflowMap.get(onb.workflowId) : null;
      const type = onb.type || 'INITIATE';
      const isInitiate = type === 'INITIATE';

      const primary: any[] = [];
      const secondary: any[] = [];

      const incomingPermissions = Array.isArray(dataBlob?.permissions)
        ? dataBlob.permissions
        : [];
      const existingPermissions = (existingUser?.userAccesses || []).map(
        (access: any) => ({
          roleCategory: access.role?.category || '',
          roleSubCategory: access.role?.subCategory || '',
          roleName: access.role?.roleName || access.roleCode,
          nodeName: access.orgStructure?.nodeName || '',
          nodePath: access.orgStructure?.nodePath || '',
          nodeType: access.orgStructure?.nodeType || null,
          accessCategory: access.accessCategory || null,
          accessType: access.accessType || 'SECONDARY',
          isGlobalAccess: access.isGlobalAccess || false,
          nodeStatus: access.orgStructure?.status || null,
        }),
      );
      const effectivePermissions =
        incomingPermissions.length > 0
          ? isInitiate || existingPermissions.length === 0
            ? incomingPermissions.filter(
              (permission: any) =>
                !UserDbController.isPermissionRemoval(permission) &&
                hasActivePermissionNode(permission),
            )
            : UserDbController.mergePermissionMutations(
              existingPermissions.filter(
                (permission: any) => permission.nodeStatus === 'ACTIVE',
              ),
              incomingPermissions.filter(hasActivePermissionNode),
            )
          : existingPermissions.filter(
            (permission: any) => permission.nodeStatus === 'ACTIVE',
          );
      const responseNewData =
        isInitiate || !dataBlob
          ? null
          : {
            ...dataBlob,
            permissions: incomingPermissions.filter(
              (permission: any) =>
                !UserDbController.isPermissionRemoval(permission) &&
                hasActivePermissionNode(permission),
            ),
          };

      effectivePermissions.forEach((p: any) => {
        const access = {
          roleCategory: p.roleCategory,
          roleSubCategory: p.roleSubCategory,
          roleName: p.roleName,
          nodeName: p.nodeName,
          nodePath: p.nodePath,
          nodeType: p.nodeType,
          accessCategory: p.accessCategory,
        };
        if (
          p.isGlobal === true ||
          p.isGlobalAccess === true ||
          p.accessType === 'PRIMARY'
        ) {
          primary.push(access);
        } else {
          secondary.push(access);
        }
      });

      return {
        id: onb.id,
        type,
        impact: onb.impact || null,
        oldData: isInitiate ? null : (onb.oldData || dataBlob?.oldData || null),
        newData: responseNewData,
        approver: approve?.user || null,
        basicDetails: {
          name: basic.name ?? existingUser?.name ?? null,
          email: basic.email ?? existingUser?.email ?? null,
          phone: basic.phone ?? existingUser?.phone ?? null,
          createdAt: onb.createdAt,
          designation:
            basic.designation !== undefined
              ? basic.designation
              : (existingMapping?.designation ?? null),
          employeeId:
            basic.employeeId !== undefined
              ? basic.employeeId
              : (existingMapping?.employeeId ?? null),
          status:
            basic.status !== undefined
              ? basic.status
              : (existingMapping?.status ?? null),
          reportingManagerName:
            managerInfo?.name || existingMapping?.manager?.name || null,
          reportingManagerEmail:
            managerInfo?.email || existingMapping?.manager?.email || null,
          initiatorName: init?.user?.name || null,
          initiatorEmail: init?.user?.email || null,
          initiatedDate: onb.createdAt,
          workflowName: w?.name || 'N/A',
          alias: w?.alias || 'N/A',
        },
        primary,
        secondary,
      };
    });
  }

  /**
   * Fetches all users associated with a company, including those with pending onboarding requests.
   * This method performs several steps to provide a unified view:
   * 1. Fetches 'active' and 'inactive' users from the production tables.
   * 2. Fetches 'pending' users from the onboarding table.
   * 3. Enhances pending user data with initiator and manager information for UI display.
   */
  static async fetchAllUsers(req: Request, res: Response, next: NextFunction) {
    try {
      const { companyCode, companyId, userId, listType } = req.body;
      const query = UserDbController.normalizeFilterText(req.body?.query);
      const pagination = getPagination(req.body);
      const rawPage = Number(req.body?.page);
      const requestedPage =
        req.body?.page !== null &&
          req.body?.page !== undefined &&
          Number.isFinite(rawPage) &&
          rawPage > 0
          ? Math.floor(rawPage)
          : null;
      const limit = pagination.limit;
      const pageDirection = UserDbController.normalizePageDirection(
        req.body?.direction,
      );
      const rawCursor =
        req.body?.cursor ??
        (pageDirection === 'prev'
          ? req.body?.prevCursor
          : req.body?.nextCursor) ??
        req.body?.cursorId ??
        null;
      const hasCursor = UserDbController.decodeCursor(rawCursor) !== null;
      const isPagePagination = requestedPage !== null && !hasCursor;
      const offset = isPagePagination
        ? (requestedPage - 1) * limit
        : pagination.offset;
      const page = requestedPage ?? Math.floor(offset / limit) + 1;
      const requestedCursor = isPagePagination ? null : rawCursor;
      const requestedTopCursor = isPagePagination
        ? null
        : req.body?.topCursor || null;
      const cursor = isPagePagination
        ? null
        : UserDbController.decodeCursor(requestedCursor);
      const topCursor = isPagePagination
        ? null
        : UserDbController.decodeCursor(requestedTopCursor);
      const effectiveDirection = cursor ? pageDirection : 'next';
      let resolvedCompanyId = companyId;

      // Resolve companyId for filtering production users
      if (!resolvedCompanyId) {
        if (!companyCode) {
          throw new AppError('Company code or companyId is required', 400);
        }
        const company = await prisma.company.findUnique({
          where: { companyCode },
        });
        if (!company) throw new AppError('Company not found', 404);
        resolvedCompanyId = company.id;
      }

      // Check if requester is a global access user
      let isGlobal = true;
      let allVisibleNodeIds: string[] = [];
      let allVisibleNodePaths: string[] = [];

      if (userId) {
        const globalAccess = await prisma.userAccess.findFirst({
          where: {
            userId,
            companyId: resolvedCompanyId,
            isGlobalAccess: true,
          },
        });

        if (!globalAccess) {
          isGlobal = false;
          // Get all view-capable USER_ACC assignments to determine visibility scope.
          // A secondary assignment grants the same scoped view permission as a primary one.
          const requesterAccesses = await prisma.userAccess.findMany({
            where: {
              userId,
              companyId: resolvedCompanyId,
              role: {
                subCategory: 'USER_ACC',
                view: true,
              },
            },
            include: { orgStructure: { select: { nodePath: true } } },
          });

          if (requesterAccesses.length > 0) {
            const nodePaths = requesterAccesses
              .filter((a) => a.accessCategory === 'NODE')
              .map((a) => a.orgStructure.nodePath);

            const immediateChildPaths = requesterAccesses
              .filter((a) => a.accessCategory === 'IMMEDIATE_CHILD')
              .map((a) => a.orgStructure.nodePath);

            const allChildPaths = requesterAccesses
              .filter((a) => a.accessCategory === 'ALL_CHILD')
              .map((a) => a.orgStructure.nodePath);

            // Fetch all nodes that fall within the requester's visibility categories
            const visibleNodes = await prisma.orgStructure.findMany({
              where: {
                companyId: resolvedCompanyId,
                OR: [
                  // 1. Direct nodes (for NODE, IMMEDIATE_CHILD, ALL_CHILD)
                  {
                    nodePath: {
                      in: [
                        ...nodePaths,
                        ...immediateChildPaths,
                        ...allChildPaths,
                      ],
                    },
                  },
                  // 2. All descendants (for ALL_CHILD)
                  ...allChildPaths.map((path) => ({
                    nodePath: { startsWith: `${path}.` },
                  })),
                  // 3. Immediate children only (for IMMEDIATE_CHILD)
                  ...immediateChildPaths.map((path) => ({
                    parent: { nodePath: path },
                  })),
                ],
              },
              select: { id: true, nodePath: true },
            });

            allVisibleNodeIds = visibleNodes.map((n) => n.id);
            allVisibleNodePaths = visibleNodes.map((n) => n.nodePath);
          }
        }
      }

      const buildUserWhere = (status: 'ACTIVE' | 'INACTIVE') => ({
        userMappings: {
          some: {
            companyId: resolvedCompanyId,
            status,
          },
        },
        ...(query
          ? {
            OR: [
              { name: { contains: query, mode: 'insensitive' as const } },
              { email: { contains: query, mode: 'insensitive' as const } },
              { phone: { contains: query, mode: 'insensitive' as const } },
              {
                userMappings: {
                  some: {
                    companyId: resolvedCompanyId,
                    designation: {
                      contains: query,
                      mode: 'insensitive' as const,
                    },
                  },
                },
              },
            ],
          }
          : {}),
        ...(isGlobal
          ? {}
          : {
            AND: [
              {
                userAccesses: {
                  some: {
                    companyId: resolvedCompanyId,
                    nodeId: { in: allVisibleNodeIds },
                  },
                },
              },
              {
                userAccesses: {
                  none: {
                    isGlobalAccess: true,
                    companyId: resolvedCompanyId,
                  },
                },
              },
            ],
          }),
      });

      const userInclude = {
        userMappings: {
          where: { companyId: resolvedCompanyId },
          include: {
            company: true,
            manager: true,
          },
        },
        userAccesses: {
          where: { companyId: resolvedCompanyId },
          include: {
            role: true,
            orgStructure: true,
          },
        },
      };

      const [activeCount, inactiveCount] = await prisma.$transaction([
        prisma.user.count({ where: buildUserWhere('ACTIVE') }),
        prisma.user.count({ where: buildUserWhere('INACTIVE') }),
      ]);

      const activeWhere = buildUserWhere('ACTIVE');
      const inactiveWhere = buildUserWhere('INACTIVE');
      const selectedUserWhere = listType === 'inactive' ? inactiveWhere : activeWhere;
      const selectedUserPageWhere =
        (listType === 'active' || listType === 'inactive') && cursor
          ? UserDbController.appendCursorWhere(
            selectedUserWhere,
            cursor,
            effectiveDirection === 'prev' ? 'newer' : 'older',
          )
          : selectedUserWhere;
      const selectedUserNewWhere =
        (listType === 'active' || listType === 'inactive') && topCursor
          ? UserDbController.appendCursorWhere(selectedUserWhere, topCursor, 'newer')
          : null;

      const [selectedRows, inactiveRows, pendingResult, selectedNewCount] =
        await Promise.all([
          listType === 'pending'
            ? Promise.resolve([])
            : prisma.user.findMany({
              where: selectedUserPageWhere,
              include: userInclude,
              orderBy: UserDbController.getPageOrder(effectiveDirection),
              ...(listType === 'active' || listType === 'inactive'
                ? { skip: cursor ? 0 : offset, take: limit + 1 }
                : {}),
            }),
          listType
            ? Promise.resolve([])
            : prisma.user.findMany({
              where: buildUserWhere('INACTIVE'),
              include: userInclude,
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            }),
          listType === 'active'
            ? Promise.resolve({ pendingCount: 0, pendingOnboardings: [] })
            : UserDbController.fetchPendingUserOnboardings({
              resolvedCompanyId,
              isGlobal,
              visibleNodePaths: allVisibleNodePaths,
              offset,
              limit,
              applyPagination: listType === 'pending',
              page,
              isPagePagination,
              cursor,
              topCursor,
              requestedTopCursor,
              direction: effectiveDirection,
              query,
              viewerUserId: userId,
            }),
          selectedUserNewWhere
            ? prisma.user.count({ where: selectedUserNewWhere })
            : Promise.resolve(0),
        ]);

      const selectedPage =
        listType === 'active' || listType === 'inactive'
          ? UserDbController.buildPageInfo(
            selectedRows,
            limit,
            requestedTopCursor,
            selectedNewCount,
            effectiveDirection,
            cursor,
            page,
            isPagePagination,
          )
          : { pageRows: selectedRows, pageInfo: null };
      const firstActivePageRow = selectedPage.pageRows[0];
      if (
        (listType === 'active' || listType === 'inactive') &&
        !isPagePagination &&
        cursor &&
        firstActivePageRow &&
        selectedPage.pageInfo
      ) {
        const newerCount = await prisma.user.count({
          where: UserDbController.appendCursorWhere(
            selectedUserWhere,
            firstActivePageRow,
            'newer',
          ),
        });
        selectedPage.pageInfo.page = Math.floor(newerCount / limit) + 1;
      }
      const activeEmails = selectedPage.pageRows
        .map((user: any) => user.email)
        .filter(Boolean);
      const activePendingCandidates =
        activeEmails.length > 0
          ? await prisma.userOnboarding.findMany({
            where: {
              companyId: resolvedCompanyId,
              status: 'PENDING',
              OR: activeEmails.flatMap((email: string) => [
                {
                  data: {
                    path: ['targetUserEmail'],
                    equals: email,
                  } as any,
                },
                {
                  data: {
                    path: ['basicDetails', 'email'],
                    equals: email,
                  } as any,
                },
              ]),
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          })
          : [];
      const activeEffectivePendingIds =
        await UserDbController.filterEffectivelyPendingRequestIds(
          'user_onboarding',
          activePendingCandidates.map((request: any) => request.id),
        );
      const activePendingRequests = activePendingCandidates.filter(
        (request: any) => activeEffectivePendingIds.has(request.id),
      );
      const activePendingByEmail = new Map<string, any>();
      activePendingRequests.forEach((request: any) => {
        const requestData = request.data as any;
        const email = (
          requestData?.targetUserEmail ||
          requestData?.basicDetails?.email ||
          ''
        ).toLowerCase();
        if (email && !activePendingByEmail.has(email)) {
          activePendingByEmail.set(email, request);
        }
      });
      const selectedUsers = selectedPage.pageRows.map((user: any) =>
        UserDbController.formatProductionUser(
          user,
          activePendingByEmail.get((user.email || '').toLowerCase()),
        ),
      );
      const activeUsers =
        listType === 'inactive'
          ? []
          : selectedUsers;
      const inactiveUsers =
        listType === 'inactive'
          ? selectedUsers
          : inactiveRows.map(
            UserDbController.formatProductionUser,
          );
      const pendingUsers = await UserDbController.formatPendingUsers(
        pendingResult.pendingOnboardings,
        resolvedCompanyId,
      );
      const pendingCount =
        listType === 'active'
          ? (
            await UserDbController.fetchPendingUserOnboardings({
              resolvedCompanyId,
              isGlobal,
              visibleNodePaths: allVisibleNodePaths,
              offset: 0,
              limit: 1,
              applyPagination: true,
              page,
              isPagePagination,
              query,
              viewerUserId: userId,
            })
          ).pendingCount
          : pendingResult.pendingCount;

      res.status(200).json({
        message: 'Users fetched successfully!',
        code: 200,
        data: {
          activeUsers,
          pendingUsers,
          inactiveUsers,
        },
        activeCount,
        inactiveCount,
        pendingCount,
        limit,
        offset,
        pageInfo:
          listType === 'active' || listType === 'inactive'
            ? selectedPage.pageInfo
            : (pendingResult as any).pageInfo || null,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Fetches unique user filter options for ACTIVE users and PENDING user requests.
   */
  static async fetchUserFilterOptions(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { companyCode, companyId } = req.body;

      const company = companyId
        ? await prisma.company.findUnique({
          where: { id: companyId },
          select: { id: true, companyCode: true },
        })
        : companyCode
          ? await prisma.company.findUnique({
            where: { companyCode },
            select: { id: true, companyCode: true },
          })
          : null;

      if (!company) {
        throw new AppError('Company not found', 404);
      }

      const resolvedCompanyId = company.id;

      const [activeUsers, pendingOnboardings] = await Promise.all([
        prisma.user.findMany({
          where: {
            userMappings: {
              some: {
                companyId: resolvedCompanyId,
                status: 'ACTIVE',
              },
            },
          },
          select: {
            userMappings: {
              where: {
                companyId: resolvedCompanyId,
                status: 'ACTIVE',
              },
              select: {
                designation: true,
                manager: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                  },
                },
              },
            },
            userAccesses: {
              where: { companyId: resolvedCompanyId },
              select: {
                accessType: true,
                isGlobalAccess: true,
                role: {
                  select: {
                    category: true,
                    subCategory: true,
                  },
                },
                orgStructure: {
                  select: {
                    nodeName: true,
                    nodePath: true,
                    nodeType: true,
                  },
                },
              },
            },
          },
        }),
        prisma.userOnboarding.findMany({
          where: {
            companyId: resolvedCompanyId,
            status: 'PENDING',
          },
          select: {
            data: true,
          },
        }),
      ]);

      const pendingManagerEmails = new Set<string>();
      const pendingNodePaths = new Set<string>();

      pendingOnboardings.forEach((onboarding) => {
        const dataBlob = onboarding.data as any;
        const basicDetails = dataBlob?.basicDetails || {};
        const permissions = Array.isArray(dataBlob?.permissions)
          ? dataBlob.permissions
          : [];
        const managerEmail = UserDbController.normalizeFilterText(
          basicDetails.reportingManager,
        );

        if (managerEmail) {
          pendingManagerEmails.add(managerEmail.toLowerCase());
        }

        permissions
          .filter(
            (permission: any) =>
              !UserDbController.isPermissionRemoval(permission),
          )
          .forEach((permission: any) => {
            const nodePath = UserDbController.normalizeFilterText(
              permission?.nodePath,
            );
            if (nodePath) {
              pendingNodePaths.add(nodePath);
            }
          });
      });

      const [pendingManagers, pendingNodes] = await Promise.all([
        pendingManagerEmails.size > 0
          ? prisma.user.findMany({
            where: {
              email: {
                in: Array.from(pendingManagerEmails),
                mode: 'insensitive',
              },
            },
            select: {
              id: true,
              name: true,
              email: true,
            },
          })
          : Promise.resolve([]),
        pendingNodePaths.size > 0
          ? prisma.orgStructure.findMany({
            where: {
              companyId: resolvedCompanyId,
              nodePath: {
                in: Array.from(pendingNodePaths),
              },
            },
            select: {
              nodeName: true,
              nodePath: true,
              nodeType: true,
            },
          })
          : Promise.resolve([]),
      ]);

      const pendingManagerByEmail = new Map(
        pendingManagers.map((manager) => [
          manager.email.toLowerCase(),
          manager,
        ]),
      );
      const pendingNodeByPath = new Map(
        pendingNodes.map((node) => [node.nodePath.toLowerCase(), node]),
      );

      const designationOptions = new Map<string, TextFilterOption>();
      const departmentOptions = new Map<string, NodeFilterOption>();
      const categoryOptions = new Map<string, TextFilterOption>();
      const subCategoryOptions = new Map<string, TextFilterOption>();
      const primaryNodeOptions = new Map<string, NodeFilterOption>();
      const secondaryNodeOptions = new Map<string, NodeFilterOption>();
      const reportingManagerOptions = new Map<string, ManagerFilterOption>();

      const addDepartment = (node: NodeFilterOption | null) => {
        UserDbController.addDepartmentFilterOption(departmentOptions, node);
      };

      activeUsers.forEach((user) => {
        const mapping = user.userMappings[0];

        UserDbController.addTextFilterOption(
          designationOptions,
          mapping?.designation,
        );
        UserDbController.addManagerFilterOption(
          reportingManagerOptions,
          mapping?.manager || null,
        );

        user.userAccesses.forEach((access) => {
          UserDbController.addTextFilterOption(
            categoryOptions,
            access.role?.category,
          );
          UserDbController.addTextFilterOption(
            subCategoryOptions,
            access.role?.subCategory,
          );

          if (access.isGlobalAccess || access.accessType === 'PRIMARY') {
            const node = UserDbController.addNodeFilterOption(
              primaryNodeOptions,
              access.orgStructure,
            );
            addDepartment(node);
          } else if (access.accessType === 'SECONDARY') {
            const node = UserDbController.addNodeFilterOption(
              secondaryNodeOptions,
              access.orgStructure,
            );
            addDepartment(node);
          }
        });
      });

      pendingOnboardings.forEach((onboarding) => {
        const dataBlob = onboarding.data as any;
        const basicDetails = dataBlob?.basicDetails || {};
        const permissions = Array.isArray(dataBlob?.permissions)
          ? dataBlob.permissions
          : [];

        UserDbController.addTextFilterOption(
          designationOptions,
          basicDetails.designation,
        );

        const managerEmail = UserDbController.normalizeFilterText(
          basicDetails.reportingManager,
        );
        if (managerEmail) {
          const manager = pendingManagerByEmail.get(
            managerEmail.toLowerCase(),
          ) || {
            email: managerEmail,
          };
          UserDbController.addManagerFilterOption(
            reportingManagerOptions,
            manager,
          );
        }

        permissions
          .filter(
            (permission: any) =>
              !UserDbController.isPermissionRemoval(permission),
          )
          .forEach((permission: any) => {
            UserDbController.addTextFilterOption(
              categoryOptions,
              permission?.roleCategory,
            );
            UserDbController.addTextFilterOption(
              subCategoryOptions,
              permission?.roleSubCategory,
            );

            const pendingNodePath = UserDbController.normalizeFilterText(
              permission?.nodePath,
            );
            const nodeFromDb = pendingNodePath
              ? pendingNodeByPath.get(pendingNodePath.toLowerCase())
              : null;
            const node = {
              nodeName: nodeFromDb?.nodeName || permission?.nodeName,
              nodePath: nodeFromDb?.nodePath || permission?.nodePath,
              nodeType: nodeFromDb?.nodeType || permission?.nodeType,
            };
            const isPrimary =
              permission?.isGlobal === true ||
              permission?.isGlobalAccess === true ||
              permission?.accessType === 'PRIMARY';

            if (isPrimary) {
              const primaryNode = UserDbController.addNodeFilterOption(
                primaryNodeOptions,
                node,
              );
              addDepartment(primaryNode);
            } else {
              const secondaryNode = UserDbController.addNodeFilterOption(
                secondaryNodeOptions,
                node,
              );
              addDepartment(secondaryNode);
            }
          });
      });

      res.status(200).json({
        message: 'User filter options fetched successfully!',
        code: 200,
        companyCode: company.companyCode,
        data: {
          designation: UserDbController.sortFilterOptions(designationOptions),
          department: UserDbController.sortFilterOptions(departmentOptions),
          category: UserDbController.sortFilterOptions(categoryOptions),
          subCategory: UserDbController.sortFilterOptions(subCategoryOptions),
          primaryNode: UserDbController.sortFilterOptions(primaryNodeOptions),
          secondaryNode:
            UserDbController.sortFilterOptions(secondaryNodeOptions),
          reportingManager: UserDbController.sortFilterOptions(
            reportingManagerOptions,
          ),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Updates the status (ACTIVE/INACTIVE) of a user mapping for a specific company.
   */
  static async updateUserStatus(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { userId, status } = req.body;
      await prisma.userMapping.updateMany({
        where: { userId },
        data: { status },
      });
      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  }

  private static async createUserModificationRequest(
    req: Request,
    res: Response,
    type: UserRequestType,
  ) {
    const {
      initiatorId,
      companyId,
      targetEmail,
      levelsHash,
      remarks,
      data = {},
    } = req.body;

    if (!initiatorId || !companyId) {
      throw new AppError('initiatorId and companyId are required', 400);
    }

    await UserDbController.validateModificationPermission(
      initiatorId,
      companyId,
    );

    if (!targetEmail) {
      throw new AppError('targetUserEmail is required', 400);
    }

    const target = await prisma.user.findUnique({
      where: { email: targetEmail },
    });

    if (!target) {
      throw new AppError('Target user not found', 404);
    }

    const adminAccess = await prisma.userAccess.findFirst({
      where: {
        userId: target.id,
        companyId,
        OR: [{ roleCode: 'SAAS_ADMIN' }, { roleCode: 'CORP_ADMIN' }],
      },
    });

    if (adminAccess) {
      throw new AppError('SAAS Admin and Corp Admin users cannot be modified', 400);
    }

    const current = await UserDbController.fetchUserSnapshot(
      prisma as any,
      target.id,
      companyId,
    );

    if (current.mapping.status === 'ARCHIVE') {
      throw new AppError(
        'Archived users cannot be modified or reactivated',
        400,
      );
    }
    if (type === 'ACTIVE' && current.mapping.status === 'ACTIVE') {
      throw new AppError('User is already active', 400);
    }
    if (
      (type === 'INACTIVE' || type === 'ARCHIVE') &&
      current.mapping.status !== 'ACTIVE'
    ) {
      throw new AppError('Only active users can be disabled or deleted', 400);
    }

    const pending = await prisma.userOnboarding.findFirst({
      where: {
        companyId,
        status: 'PENDING',
        OR: [
          {
            data: {
              path: ['targetUserEmail'],
              equals: current.user.email,
            },
          },
          {
            data: {
              path: ['basicDetails', 'email'],
              equals: current.user.email,
            },
          },
        ],
      },
    });
    if (pending) {
      const initiateHistory = await prisma.userHistory.findFirst({
        where: { reqId: pending.id, event: 'INITIATE' },
        include: { user: true },
        orderBy: { createdAt: 'asc' },
      });
      const initiator = initiateHistory?.user;
      const initiatedAt = initiateHistory?.createdAt || pending.createdAt;
      throw new AppError(
        `Cannot inactivate user '${current.user.email}'. There is an active pending ${pending.type || 'UPDATE'} request initiated by ${initiator?.name || 'Unknown'} - ${initiator?.email || 'unknown'} on ${UserDbController.formatConflictDate(initiatedAt)}. Please resolve this pending request first.`,
        400,
      );
    }

    const initiator = await prisma.user.findUnique({
      where: { id: initiatorId },
      select: { email: true },
    });
    if (!initiator) {
      throw new AppError('Initiator not found', 404);
    }

    const initiatorRestriction = await prisma.userOnboarding.findFirst({
      where: {
        companyId,
        data: {
          path: ['targetUserEmail'],
          equals: initiator.email,
        },
        status: 'PENDING',
        OR: [
          { type: { in: ['INACTIVE', 'ARCHIVE'] } },
          { impact: 'DOWNGRADE' },
        ],
      },
    });
    if (initiatorRestriction) {
      throw new AppError(
        'Initiator has a pending downgrade, inactive or archive request',
        400,
      );
    }

    const permissionMutations = Array.isArray(data?.permissions)
      ? data.permissions
      : [];
    await UserDbController.validateChangedPermissions(
      companyId,
      permissionMutations,
    );
    await UserDbController.validateReportingManagerChange(
      target.id,
      companyId,
      data?.basicDetails?.reportingManager,
    );

    const proposed: UserDataSnapshot = {
      basicDetails: { ...current.snapshot.basicDetails },
      permissions:
        type === 'ARCHIVE'
          ? []
          : UserDbController.mergePermissionMutations(
            current.snapshot.permissions,
            permissionMutations,
          ),
    };
    const changedDetails = data?.basicDetails || {};
    const editableFields = [
      'name',
      'email',
      'phone',
      'designation',
      'employeeId',
      'reportingManager',
    ] as const;
    for (const field of editableFields) {
      if (changedDetails[field] !== undefined) {
        proposed.basicDetails[field] = changedDetails[field];
      }
    }
    if (proposed.basicDetails.email !== current.snapshot.basicDetails.email) {
      const existingEmailUser = await prisma.user.findUnique({
        where: { email: proposed.basicDetails.email },
        select: { id: true },
      });
      if (existingEmailUser && existingEmailUser.id !== target.id) {
        throw new AppError('Email is already assigned to another user', 400);
      }
    }

    if (type === 'ACTIVE') proposed.basicDetails.status = 'ACTIVE';
    if (type === 'INACTIVE') proposed.basicDetails.status = 'INACTIVE';
    if (type === 'ARCHIVE') proposed.basicDetails.status = 'ARCHIVE';

    const permissionDiff = UserDbController.buildPermissionDiff(
      current.snapshot.permissions,
      proposed.permissions,
    );
    const requiresPrimaryValidation =
      permissionMutations.length > 0 || type === 'ACTIVE';
    if (
      requiresPrimaryValidation &&
      type !== 'INACTIVE' &&
      type !== 'ARCHIVE' &&
      proposed.permissions.filter(
        (permission) => permission.accessType === 'PRIMARY',
      ).length !== 1
    ) {
      throw new AppError(
        'Exactly one PRIMARY permission is required for an active user',
        400,
      );
    }

    const detailsChanged = editableFields.some(
      (field) =>
        current.snapshot.basicDetails[field] !== proposed.basicDetails[field],
    );
    const permissionsChanged =
      permissionDiff.added.length > 0 ||
      permissionDiff.removed.length > 0 ||
      permissionDiff.updated.length > 0;
    const statusChanged =
      current.snapshot.basicDetails.status !== proposed.basicDetails.status;
    if (!detailsChanged && !permissionsChanged && !statusChanged) {
      throw new AppError('No user changes were provided', 400);
    }

    const changeData = UserDbController.buildUserHistoryChangeData(
      current.snapshot,
      proposed,
      permissionDiff,
    );

    const impact = await UserDbController.calculateModificationImpact(
      type,
      current.snapshot,
      proposed,
      permissionDiff,
    );
    if (
      impact === 'DOWNGRADE' ||
      impact === 'INACTIVE' ||
      impact === 'ARCHIVE'
    ) {
      const pendingApprovalRows = await prisma.workflowApprover.findMany({
        where: { status: 'PENDING' },
        select: { reqId: true, approversList: true },
      });
      const blockingApproval = pendingApprovalRows.find(
        (row) =>
          Array.isArray(row.approversList) &&
          row.approversList.includes(target.id),
      );
      if (blockingApproval) {
        const blockingReqIds = pendingApprovalRows
          .filter(
            (row) =>
              Array.isArray(row.approversList) &&
              row.approversList.includes(target.id),
          )
          .map((row) => row.reqId);
        const userReqs = await prisma.userOnboarding.findMany({
          where: { id: { in: blockingReqIds } },
          select: {
            id: true,
            type: true,
            data: true,
            initiatorId: true,
          },
          take: 11,
        });
        const initiatorIds = Array.from(
          new Set(
            userReqs
              .map((req) => req.initiatorId)
              .filter((id): id is string => typeof id === 'string'),
          ),
        );
        const initiators =
          initiatorIds.length > 0
            ? await prisma.user.findMany({
              where: { id: { in: initiatorIds } },
              select: { id: true, email: true },
            })
            : [];
        const initiatorMap = new Map(
          initiators.map((initiator) => [initiator.id, initiator.email]),
        );
        const lines = userReqs
          .slice(0, 10)
          .map((req) => {
            const data = req.data as any;
            const targetName =
              data?.targetUserEmail ||
              data?.target?.nodePath ||
              data?.targetNodePath ||
              data?.basicDetails?.email ||
              'N/A';
            const initiatorEmail = req.initiatorId
              ? initiatorMap.get(req.initiatorId) || 'unknown'
              : 'unknown';
            return `- Request ID: #${req.id} | Type: ${req.type || 'N/A'} | Target: ${targetName} | Initiator: ${initiatorEmail}`;
          })
          .join('\n');
        const remaining = Math.max(blockingReqIds.length - 10, 0);
        const remainingLine =
          remaining > 0
            ? `\nand ${remaining} other pending workflow(s)...`
            : '';
        throw new AppError(
          `Cannot inactivate user '${current.user.email}' because they are currently assigned as an active/eligible approver for ${blockingReqIds.length} pending approval request(s). Please reassign the approval tasks or wait for them to finish before disabling this user:\n${lines}${remainingLine}`,
          400,
        );
      }
    }

    const primaryPermission =
      proposed.permissions.find(
        (permission) => permission.accessType === 'PRIMARY',
      ) ||
      current.snapshot.permissions.find(
        (permission) => permission.accessType === 'PRIMARY',
      ) ||
      proposed.permissions[0] ||
      current.snapshot.permissions[0];
    const approvalNode = primaryPermission
      ? await prisma.orgStructure.findFirst({
        where: { companyId, nodePath: primaryPermission.nodePath },
      })
      : await prisma.orgStructure.findFirst({
        where: { companyId, nodeType: 'ROOT' },
      });

    if (!approvalNode) {
      throw new AppError('Organization node not found for user workflow', 400);
    }

    const requestData: Record<string, unknown> = {
      targetUserEmail: current.user.email,
      ...(data || {}),
    };
    if (statusChanged) {
      requestData.basicDetails = {
        ...((requestData.basicDetails as Record<string, unknown>) || {}),
        status: proposed.basicDetails.status,
      };
    }
    let notificationRecipients: string[] = [];
    const onboarding = await prisma.$transaction(async (tx) => {
      const request = await tx.userOnboarding.create({
        data: {
          companyId,
          initiatorId,
          type,
          impact,
          data: requestData as any,
          oldData: changeData.oldData as any,
          remarks: remarks || null,
          status: 'PENDING',
        },
      });

      const workflow = await WorkflowApproverUtil.resolveAndCreateApprovers(
        tx,
        {
          levelsHash: levelsHash || null,
          module: 'SYSTEM_ACCESS',
          subModule: 'USER_ACC',
          companyId,
          nodeId: approvalNode.id,
          initiatorId,
          reqId: request.id,
          reqTable: 'user_onboarding',
        },
      );
      notificationRecipients = workflow.eligibleApprovers;
      await tx.userOnboarding.update({
        where: { id: request.id },
        data: {
          workflowId: workflow.workflowId,
        },
      });
      await tx.userHistory.create({
        data: {
          email: current.user.email,
          event: 'INITIATE',
          eventUserId: initiatorId,
          companyId,
          reqId: request.id,
          remarks: remarks || null,
        },
      });

      return request;
    });

    const userReferenceName = UserDbController.formatUserReferenceName(
      current.user,
    );
    const modificationNotification = UserDbController.getUserNotificationContent(
      type,
      'initiated',
      userReferenceName,
    );
    const corpAdminUserIds = await NotificationService.getCorpAdminUserIds(
      companyId,
    );
    await NotificationService.createRequestNotification({
      companyId,
      type: UserDbController.getUserNotificationType(type, 'PENDING'),
      name: modificationNotification.name,
      message: modificationNotification.message,
      referenceType: 'USER',
      referenceId: onboarding.id,
      referenceName: userReferenceName,
      createdBy: initiatorId,
      recipientUserIds: NotificationService.mergeRecipientUserIds(
        notificationRecipients,
        corpAdminUserIds,
      ),
      includeCreatedBy: true,
    });

    res.status(201).json(onboarding);
  }

  private static async removeApprovedPermission(
    tx: any,
    companyId: string,
    targetUserId: string,
    permission: UserPermissionSnapshot,
  ) {
    const [role, node] = await Promise.all([
      tx.roles.findUnique({ where: { roleName: permission.roleName } }),
      tx.orgStructure.findFirst({
        where: { companyId, nodePath: permission.nodePath },
      }),
    ]);
    if (!role || !node) return;

    await tx.userAccess.deleteMany({
      where: {
        userId: targetUserId,
        companyId,
        roleCode: role.roleCode,
        nodeId: node.id,
      },
    });
  }

  private static async upsertApprovedPermission(
    tx: any,
    companyId: string,
    targetUserId: string,
    permission: UserPermissionSnapshot,
  ) {
    const [role, node] = await Promise.all([
      tx.roles.findUnique({ where: { roleName: permission.roleName } }),
      tx.orgStructure.findFirst({
        where: { companyId, nodePath: permission.nodePath },
      }),
    ]);
    if (!role || !node) {
      throw new AppError('Approved user permission is no longer valid', 400);
    }

    await tx.userAccess.upsert({
      where: {
        userId_roleCode_companyId_nodeId: {
          userId: targetUserId,
          roleCode: role.roleCode,
          companyId,
          nodeId: node.id,
        },
      },
      update: {
        accessType: permission.accessType,
        accessCategory: permission.accessCategory || 'NODE',
        isGlobalAccess: permission.roleName === 'Corp Admin',
      },
      create: {
        userId: targetUserId,
        roleCode: role.roleCode,
        companyId,
        nodeId: node.id,
        accessType: permission.accessType,
        accessCategory:
          permission.roleName === 'Corp Admin'
            ? permission.accessCategory || 'ALL_CHILD'
            : permission.accessCategory || 'NODE',
        isGlobalAccess: permission.roleName === 'Corp Admin',
      },
    });
  }

  private static async applyApprovedUserModification(tx: any, onboarding: any) {
    const requestData = onboarding.data as any;
    const targetEmail = requestData.targetUserEmail;
    const target = targetEmail
      ? await tx.user.findUnique({ where: { email: targetEmail } })
      : null;
    if (!target) {
      throw new AppError(
        'Target user is missing from modification request',
        400,
      );
    }

    const targetUserId = target.id;
    const current = await UserDbController.fetchUserSnapshot(
      tx,
      targetUserId,
      onboarding.companyId,
    );
    const permissionMutations = Array.isArray(requestData?.permissions)
      ? requestData.permissions
      : [];
    const proposed: UserDataSnapshot = {
      basicDetails: { ...current.snapshot.basicDetails },
      permissions:
        onboarding.type === 'ARCHIVE'
          ? []
          : UserDbController.mergePermissionMutations(
            current.snapshot.permissions,
            permissionMutations,
          ),
    };
    const changedDetails = requestData?.basicDetails || {};
    const editableFields = [
      'name',
      'email',
      'phone',
      'designation',
      'employeeId',
      'reportingManager',
    ] as const;
    for (const field of editableFields) {
      if (changedDetails[field] !== undefined) {
        proposed.basicDetails[field] = changedDetails[field];
      }
    }
    if (onboarding.type === 'ACTIVE') proposed.basicDetails.status = 'ACTIVE';
    if (onboarding.type === 'INACTIVE') {
      proposed.basicDetails.status = 'INACTIVE';
    }
    if (onboarding.type === 'ARCHIVE') proposed.basicDetails.status = 'ARCHIVE';
    if (changedDetails.status !== undefined) {
      proposed.basicDetails.status = changedDetails.status;
    }
    const permissionDiff = UserDbController.buildPermissionDiff(
      current.snapshot.permissions,
      proposed.permissions,
    );
    const manager = proposed.basicDetails.reportingManager
      ? await tx.user.findUnique({
        where: { email: proposed.basicDetails.reportingManager },
      })
      : null;

    if (proposed.basicDetails.reportingManager && !manager) {
      throw new AppError('Reporting Manager not found', 404);
    }

    if (targetEmail && targetEmail !== proposed.basicDetails.email) {
      const existingEmailUser = await tx.user.findUnique({
        where: { email: proposed.basicDetails.email },
        select: { id: true },
      });
      if (existingEmailUser && existingEmailUser.id !== targetUserId) {
        throw new AppError('Email is already assigned to another user', 400);
      }
    }

    await tx.user.update({
      where: { id: targetUserId },
      data: {
        name: proposed.basicDetails.name,
        email: proposed.basicDetails.email,
        phone: proposed.basicDetails.phone,
      },
    });
    if (targetEmail && targetEmail !== proposed.basicDetails.email) {
      await tx.userHistory.updateMany({
        where: {
          companyId: onboarding.companyId,
          email: targetEmail,
        },
        data: { email: proposed.basicDetails.email },
      });
    }
    await tx.userMapping.update({
      where: {
        userId_companyId: {
          userId: targetUserId,
          companyId: onboarding.companyId,
        },
      },
      data: {
        reportingManager: manager?.id || null,
        designation: proposed.basicDetails.designation,
        employeeId: proposed.basicDetails.employeeId,
        status: proposed.basicDetails.status,
      },
    });

    if (onboarding.type === 'ARCHIVE') {
      await tx.userAccess.deleteMany({
        where: { userId: targetUserId, companyId: onboarding.companyId },
      });
    } else {
      for (const permission of permissionDiff.removed) {
        await UserDbController.removeApprovedPermission(
          tx,
          onboarding.companyId,
          targetUserId,
          permission,
        );
      }
      for (const change of permissionDiff.updated) {
        await UserDbController.removeApprovedPermission(
          tx,
          onboarding.companyId,
          targetUserId,
          change.oldData,
        );
        await UserDbController.upsertApprovedPermission(
          tx,
          onboarding.companyId,
          targetUserId,
          change.newData,
        );
      }
      for (const permission of permissionDiff.added) {
        await UserDbController.upsertApprovedPermission(
          tx,
          onboarding.companyId,
          targetUserId,
          permission,
        );
      }
    }

    if (
      onboarding.type === 'INACTIVE' ||
      onboarding.type === 'ARCHIVE' ||
      onboarding.impact === 'DOWNGRADE'
    ) {
      await tx.userActivity.updateMany({
        where: { userId: targetUserId, companyId: onboarding.companyId },
        data: {
          refreshToken: null,
          forceLogToken: null,
          version: null,
          expiryAt: new Date(),
        },
      });
    }
  }

  /**
   * Creates a new user onboarding request in the database.
   * Performs an atomic transaction to create the request and the initial history log.
   */
  /**
   * Creates a new user onboarding request.
   * Performs an atomic transaction to:
   * 1. Create the onboarding record.
   * 2. Resolve the workflow (explicit or default for USER_ACC section).
   * 3. Build WorkflowApprover rows for each approval level.
   * 4. Log the INITIATE event in UserHistory with the reqId.
   */
  static async createUserOnboarding(req: Request, res: Response) {
    try {
      const type = UserDbController.normalizeUserRequestType(req.body?.type);
      if (type !== 'INITIATE') {
        try {
          return await UserDbController.createUserModificationRequest(
            req,
            res,
            type,
          );
        } catch (error) {
          const initiatorId = req.body?.initiatorId;
          const companyId = req.body?.companyId;
          const targetEmail = req.body?.targetEmail || req.body?.targetUserEmail;
          if (
            typeof initiatorId === 'string' &&
            typeof companyId === 'string'
          ) {
            await UserDbController.notifyConflict(
              companyId,
              initiatorId,
              error instanceof Error ? error.message : 'Unexpected error',
              String(targetEmail || 'user'),
              NotificationService.mergeRecipientUserIds(
                req.body?.eligibleApprovers,
              ),
            );
          }
          throw error;
        }
      }

      const {
        initiatorId,
        companyCode,
        companyId,
        groupCode,
        levelsHash,
        ...onboardingData
      } = req.body;
      let resolvedCompanyId = companyId;

      if (!resolvedCompanyId) {
        if (!companyCode) {
          throw new AppError('companyCode or companyId is required', 400);
        }
        const company = await prisma.company.findUnique({
          where: { companyCode },
        });
        if (!company) {
          throw new AppError('Company not found', 404);
        }
        resolvedCompanyId = company.id;
      }

      const basicDetails = onboardingData.data?.basicDetails || {};
      const email = basicDetails.email;
      const userReferenceName = UserDbController.formatUserReferenceName({
        name: basicDetails.name,
        email,
      });
      const permissions = onboardingData.data?.permissions || [];
      const originalPermissions = Array.isArray(permissions)
        ? [...permissions]
        : [];
      await UserDbController.validateChangedPermissions(
        resolvedCompanyId,
        Array.isArray(permissions) ? permissions : [],
      );
      const requestedNodePaths = Array.from(
        new Set(
          (Array.isArray(permissions) ? permissions : [])
            .map((permission: any) => permission?.nodePath)
            .filter((value: any): value is string => typeof value === 'string' && value.trim().length > 0),
        ),
      );
      const hasCorpAdminRole =
        Array.isArray(permissions) &&
        permissions.some((p: any) => p.roleName === 'Corp Admin');

      // ── Initiator Restriction for Corp Admin ──
      if (hasCorpAdminRole) {
        const initiatorAccess = await prisma.userAccess.findFirst({
          where: {
            userId: initiatorId,
            companyId: resolvedCompanyId,
            isGlobalAccess: true,
          },
        });
        if (!initiatorAccess) {
          throw new AppError(
            'Unauthorized: Only a signatory (Global Access user) can initiate a request containing the Corp Admin role',
            403,
          );
        }
      }

      for (const nodePath of requestedNodePaths) {
        await UserDbController.assertNoPendingOrgModificationForNode(
          resolvedCompanyId,
          nodePath,
        );
        await UserDbController.assertNoPendingWorkflowModificationForNode(
          resolvedCompanyId,
          nodePath,
          levelsHash || null,
        );
      }
      await UserDbController.assertSelectedApprovalWorkflowNotPendingModification(
        resolvedCompanyId,
        levelsHash || null,
      );

      // Fetch all global access users for this company to ensure they are in the master eligible list
      const globalUsers = await WorkflowApproverUtil.getGlobalAccessUserIds(
        prisma as any,
        resolvedCompanyId,
        'USER_ACC',
      );

      // Master eligible list includes both configured and global approvers.
      // Initiator is excluded from all active approval lists.
      const masterEligible = new Set([
        ...(onboardingData.eligibleApprovers || []),
        ...globalUsers,
      ]);
      onboardingData.eligibleApprovers = Array.from(masterEligible).filter(
        (id) => id !== initiatorId,
      );
      let notificationRecipients = onboardingData.eligibleApprovers;

      onboardingData.data = {
        ...(onboardingData.data || {}),
        permissions:
          await UserDbController.expandInitiatePermissionsForChildNodes(
            resolvedCompanyId,
            permissions,
          ),
      };
      const expandedInitiatePermissions = Array.isArray(
        onboardingData.data?.permissions,
      )
        ? [...onboardingData.data.permissions]
        : [];

      const onboarding = await prisma.$transaction(async (tx) => {
        let groupId: string | null = null;
        if (groupCode) {
          const group = await tx.groupCompany.findUnique({
            where: { groupCode },
          });
          if (group) {
            groupId = group.id;
          }
        }

        const onb = await tx.userOnboarding.create({
          data: {
            ...onboardingData,
            type: 'INITIATE',
            initiatorId: initiatorId || null,
            companyId: resolvedCompanyId,
            groupId: groupId,
          },
        });

        // ── Resolve workflow approvers and create WorkflowApprover rows ──────
        // Determine the node for approver resolution from the permissions data
        const permissions = onboardingData.data?.permissions || [];
        let nodeId: string | null = null;

        if (permissions.length > 0 && permissions[0].nodePath) {
          const node = await tx.orgStructure.findFirst({
            where: {
              nodePath: permissions[0].nodePath,
              companyId: resolvedCompanyId,
            },
          });
          if (node) nodeId = node.id;
        }

        // Fallback to root node if no specific node was found
        if (!nodeId) {
          const rootNode = await tx.orgStructure.findFirst({
            where: { companyId: resolvedCompanyId, nodeType: 'ROOT' },
          });
          if (rootNode) nodeId = rootNode.id;
        }

        if (nodeId && initiatorId) {
          const {
            workflowId: resolvedWorkflowId,
            eligibleApprovers: resolvedApprovers,
          } = await WorkflowApproverUtil.resolveAndCreateApprovers(tx, {
            levelsHash: levelsHash || null,
            module: 'SYSTEM_ACCESS',
            subModule: 'USER_ACC',
            companyId: resolvedCompanyId,
            nodeId,
            initiatorId,
            reqId: onb.id,
            reqTable: 'user_onboarding',
          });
          notificationRecipients = resolvedApprovers;

          // Store the resolved workflowId in the onboarding record
          await tx.userOnboarding.update({
            where: { id: onb.id },
            data: { workflowId: resolvedWorkflowId },
          });
        }

        // Log INITIATE event with reqId reference
        if (initiatorId && email) {
          await tx.userHistory.create({
            data: {
              email,
              event: 'INITIATE',
              eventUserId: initiatorId,
              companyId: resolvedCompanyId,
              reqId: onb.id,
            },
          });
        }
        return onb;
      });
      await NotificationService.createRequestNotification({
        companyId: resolvedCompanyId,
        type: 'INITIATE',
        referenceType: 'USER',
        referenceId: onboarding.id,
        referenceName: userReferenceName,
        createdBy: initiatorId,
        recipientUserIds: NotificationService.mergeRecipientUserIds(
          notificationRecipients,
          await NotificationService.getCorpAdminUserIds(resolvedCompanyId),
        ),
        includeCreatedBy: true,
        message: (() => {
          const summary = UserDbController.formatInitiatePermissionSummary(
            originalPermissions,
            expandedInitiatePermissions,
          );
          return summary
            ? `${UserDbController.getUserNotificationContent(
              'INITIATE',
              'initiated',
              userReferenceName,
            ).message} with ${summary}`
            : UserDbController.getUserNotificationContent(
              'INITIATE',
              'initiated',
              userReferenceName,
            ).message;
        })(),
      });
      res.status(201).json(onboarding);
    } catch (error) {
      const initiatorId = req.body?.initiatorId;
      let resolvedCompanyId = req.body?.companyId as string | undefined;
      if (!resolvedCompanyId && typeof req.body?.companyCode === 'string') {
        const company = await prisma.company.findUnique({
          where: { companyCode: req.body.companyCode },
          select: { id: true },
        });
        resolvedCompanyId = company?.id;
      }
      const targetEmail =
        req.body?.targetEmail ||
        req.body?.targetUserEmail ||
        req.body?.data?.basicDetails?.email;
      if (
        typeof initiatorId === 'string' &&
        typeof resolvedCompanyId === 'string'
      ) {
        await UserDbController.notifyConflict(
          resolvedCompanyId,
          initiatorId,
          error instanceof Error ? error.message : 'Unexpected error',
          String(targetEmail || 'user'),
          NotificationService.mergeRecipientUserIds(
            req.body?.eligibleApprovers,
          ),
        );
      }
      throw error;
    }
  }

  /**
   * Fetches a single user onboarding request by its ID.
   */
  static async getUserOnboardingById(req: Request, res: Response) {
    const { id, companyId } = req.body;
    const onboarding = await prisma.userOnboarding.findFirst({
      where: { id, companyId },
    });
    res.json(onboarding);
  }

  /**
   * Handles the approval or rejection of a user onboarding request.
   * Approval Flow:
   * 1. Checks if the user exists; if not, creates a new production 'User' record with a default password.
   * 2. Creates a 'UserMapping' to link the user to the company with a reporting manager.
   * 3. Iterates through requested permissions and creates 'UserAccess' records for each Role + Node pair.
   * 4. Updates the request status to 'APPROVED' and logs the audit history.
   */
  /**
   * Handles the approval or rejection of a user onboarding request.
   * Level-wise Approval Flow:
   * 1. Checks the current pending level from WorkflowApprover.
   * 2. Verifies the approver is in the current level's approversList.
   * 3. Marks the level as APPROVED and checks if more levels remain.
   * 4. If all levels are approved → creates user, mapping, access records.
   * 5. If rejected at any level → marks all levels REJECTED.
   * 6. Logs level-wise events in UserHistory.
   */
  static async handleUserOnboardingStatus(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { id, companyId, status, approverId, remark } = req.body;

      if (!companyId) {
        throw new AppError('companyId is required', 400);
      }

      const onboarding = await prisma.userOnboarding.findFirst({
        where: { id, companyId },
      });

      if (!onboarding) {
        throw new AppError('User onboarding request not found', 404);
      }

      // ── Check WorkflowApprover for level-wise authorization ──────────────
      const currentLevel = await WorkflowApproverUtil.getCurrentPendingLevel(
        id,
        'user_onboarding',
      );

      // If workflow approver rows exist, enforce level-wise checks
      if (currentLevel) {
        const approversList = currentLevel.approversList as string[];
        if (
          Array.isArray(approversList) &&
          !approversList.includes(approverId)
        ) {
          throw new AppError(
            `Unauthorized: You are not an eligible approver for level ${currentLevel.level}`,
            403,
          );
        }
      } else {
        // Fallback to legacy eligibleApprovers check if no WorkflowApprover rows exist
        if (
          onboarding.eligibleApprovers &&
          onboarding.eligibleApprovers.length > 0 &&
          !onboarding.eligibleApprovers.includes(approverId)
        ) {
          throw new AppError('Unauthorized to process this request', 403);
        }
      }

      // --- Prevent Self-Approval ---
      const initiatorLog = await prisma.userHistory.findFirst({
        where: { reqId: id, event: 'INITIATE' },
      });
      if (initiatorLog && initiatorLog.eventUserId === approverId) {
        throw new AppError('Initiator cannot approve their own request', 403);
      }

      // --- Prevent Double Approval ---
      const alreadyApproved = await WorkflowApproverUtil.isAlreadyApproved(
        prisma as any,
        id,
        'user_onboarding',
        approverId,
      );
      if (alreadyApproved) {
        throw new AppError('You have already approved this request once', 403);
      }

      const requestData = onboarding.data as any;
      const data =
        onboarding.type && onboarding.type !== 'INITIATE'
          ? requestData?.newData || requestData
          : requestData;
      const { basicDetails, permissions } = data || {};
      const { name, email, phone, reportingManager, designation, employeeId } =
        basicDetails || {};
      const historyEmail =
        onboarding.type && onboarding.type !== 'INITIATE'
          ? (requestData?.targetUserEmail ?? email)
          : email;
      let notificationRecipients = onboarding.eligibleApprovers || [];

      // ── Approver Restriction and Signatory Check ──
      const statusStr = status.toString().toLowerCase();
      const isApproving = statusStr === 'approve' || statusStr === 'approved';
      const hasCorpAdminRole =
        onboarding.type === 'INITIATE'
          ? Array.isArray(permissions) &&
          permissions.some((p: any) => p.roleName === 'Corp Admin')
          : (Array.isArray(requestData?.permissions)
            ? requestData.permissions
            : []
          ).some(
            (p: any) =>
              p.roleName === 'Corp Admin' &&
              p.operation !== 'REMOVE' &&
              p.remove !== true,
          );

      const approverAccess = await prisma.userAccess.findFirst({
        where: {
          userId: approverId,
          companyId: onboarding.companyId,
          isGlobalAccess: true,
        },
      });
      const approverIsSignatory = !!approverAccess;

      if (hasCorpAdminRole && isApproving) {
        if (!approverIsSignatory) {
          throw new AppError(
            'Unauthorized: Only a signatory (Global Access user) can approve a request containing the Corp Admin role',
            403,
          );
        }
      }

      const result = await prisma.$transaction(async (tx) => {
        // =========================
        const statusStr = status.toString().toLowerCase();
        // =========================
        // ✅ APPROVED FLOW
        // =========================
        if (statusStr === 'approve' || statusStr === 'approved') {
          // ── Level-wise approval: mark current level as APPROVED ──────────
          let allLevelsApproved = true;
          const approvedLevel = currentLevel?.level || null;

          if (currentLevel) {
            const nextLevel = await WorkflowApproverUtil.approveLevel(
              tx,
              id,
              'user_onboarding',
              currentLevel.level,
              approverId,
            );
            // If there's a next pending level, the request is NOT fully approved yet
            if (nextLevel) {
              allLevelsApproved = false;
              notificationRecipients = Array.isArray(nextLevel.approversList)
                ? (nextLevel.approversList as string[])
                : notificationRecipients;
            }
          }

          // Log level-wise APPROVED event in history
          if (historyEmail && approverId) {
            await tx.userHistory.create({
              data: {
                email: historyEmail,
                event: 'APPROVED',
                eventUserId: approverId,
                companyId: onboarding.companyId,
                reqId: id,
                level: approvedLevel,
                remarks: remark,
              },
            });
          }

          // If NOT all levels are approved, return early (partial approval)
          if (!allLevelsApproved) {
            return { status: 'PARTIAL_APPROVED', level: approvedLevel };
          }

          if (onboarding.type && onboarding.type !== 'INITIATE') {
            await UserDbController.applyApprovedUserModification(
              tx,
              onboarding,
            );
            await tx.userOnboarding.update({
              where: { id },
              data: {
                status: 'APPROVED',
                approvalRemark: remark,
              },
            });

            return { status: 'APPROVED', requestType: onboarding.type };
          }

          // ── All levels approved — proceed with production user creation ───
          const manager = await tx.user.findUnique({
            where: { id: approverId },
            include: {
              userMappings: {
                include: { company: true },
              },
            },
          });

          let reportingManagerId: string | null = null;
          if (reportingManager) {
            const reportingManagerCheck = await tx.user.findUnique({
              where: { email: reportingManager },
              include: {
                userMappings: {
                  include: { company: true },
                },
              },
            });

            if (!reportingManagerCheck) {
              throw new AppError('Reporting Manager not found', 404);
            }
            reportingManagerId = reportingManagerCheck.id;
          }

          if (!manager) throw new AppError('Manager not found', 404);

          const company = await tx.company.findUnique({
            where: { id: onboarding.companyId },
          });

          if (!company) throw new AppError('Company not found', 404);

          // 1. Production User Creation
          let user = await tx.user.findUnique({ where: { email } });
          if (!user) {
            const defaultPassword = await HashUtil.hash('Welcome@123');
            user = await tx.user.create({
              data: {
                email,
                name,
                phone,
                password: defaultPassword,
              },
            });
          }

          // 2. Map User to Company
          await tx.userMapping.create({
            data: {
              userId: user.id,
              companyId: company.id,
              reportingManager: reportingManagerId,
              status: 'ACTIVE',
              designation,
              employeeId,
            },
          });

          // 3. Setup Granular Access Permissions
          // Rule: isGlobalUser flag OR assigning Corp Admin role grants global access
          if (hasCorpAdminRole) {
            // Use nodePath from permissions if available, otherwise fallback to company ROOT node
            const globalPerm = Array.isArray(permissions)
              ? permissions.find(
                (p: any) => p.roleName === 'Corp Admin' || p.isGlobalAccess,
              )
              : null;
            const rootNode = await tx.orgStructure.findFirst({
              where: {
                companyId: company.id,
                status: 'ACTIVE',
                ...(globalPerm?.nodePath
                  ? { nodePath: globalPerm.nodePath }
                  : { nodeType: 'ROOT' }),
              },
            });

            if (rootNode) {
              const existingAccess = await tx.userAccess.findFirst({
                where: {
                  userId: user.id,
                  roleCode: 'CORP_ADMIN',
                  companyId: company.id,
                  nodeId: rootNode.id,
                },
              });

              if (existingAccess) {
                await tx.userAccess.update({
                  where: { id: existingAccess.id },
                  data: {
                    isGlobalAccess: true,
                    accessCategory: globalPerm?.accessCategory || 'ALL_CHILD',
                    accessType: 'PRIMARY',
                  },
                });
              } else {
                await tx.userAccess.create({
                  data: {
                    userId: user.id,
                    roleCode: 'CORP_ADMIN',
                    nodeId: rootNode.id,
                    companyId: company.id,
                    isGlobalAccess: true,
                    accessCategory: globalPerm?.accessCategory || 'ALL_CHILD',
                    accessType: 'PRIMARY',
                  },
                });
              }
            }
          }
          if (Array.isArray(permissions)) {
            for (const perm of permissions) {
              const { accessType, roleName, nodePath, accessCategory } = perm;
              if (!roleName || roleName === 'Corp Admin') continue; // Skip Corp Admin as it's handled above
              const finalCategory = accessCategory;

              const role = await tx.roles.findUnique({
                where: { roleName },
              });

              const node = await tx.orgStructure.findFirst({
                where: { nodePath, companyId: company.id, status: 'ACTIVE' },
              });

              if (role && node) {
                // Use upsert to handle overlapping permissions (e.g. explicit child node vs propagated from parent)
                await tx.userAccess.upsert({
                  where: {
                    userId_roleCode_companyId_nodeId: {
                      userId: user.id,
                      roleCode: role.roleCode,
                      companyId: company.id,
                      nodeId: node.id,
                    },
                  },
                  update: {
                    accessType: accessType as any,
                    accessCategory: finalCategory as any,
                  },
                  create: {
                    userId: user.id,
                    roleCode: role.roleCode,
                    nodeId: node.id,
                    accessType: accessType as any,
                    accessCategory: finalCategory as any,
                    companyId: company.id,
                    isGlobalAccess: false,
                  },
                });

                // ─── A. UPWARD PROPAGATION: Existing parent-level users to this node ───
                const parentPaths = ltree.getAncestors(nodePath);
                if (parentPaths.length > 0) {
                  const parentNodes = await tx.orgStructure.findMany({
                    where: {
                      companyId: company.id,
                      nodePath: { in: parentPaths },
                    },
                  });
                  const parentNodeIds = parentNodes.map((n) => n.id);
                  const directParentPath = ltree.getParent(nodePath);
                  const directParentId = parentNodes.find(
                    (n) => n.nodePath === directParentPath,
                  )?.id;

                  if (parentNodeIds.length > 0) {
                    const propagatingParentAccesses =
                      await tx.userAccess.findMany({
                        where: {
                          companyId: company.id,
                          nodeId: { in: parentNodeIds },
                          isGlobalAccess: false,
                          OR: [
                            { accessCategory: 'ALL_CHILD' },
                            directParentId
                              ? {
                                nodeId: directParentId,
                                accessCategory: 'IMMEDIATE_CHILD',
                              }
                              : undefined,
                          ].filter(Boolean) as any,
                        },
                      });

                    const parentToChildAccesses = propagatingParentAccesses.map(
                      (access) => ({
                        userId: access.userId,
                        roleCode: access.roleCode,
                        nodeId: node.id,
                        accessType: 'SECONDARY' as any,
                        accessCategory:
                          access.accessCategory === 'IMMEDIATE_CHILD'
                            ? ('NODE' as any)
                            : access.accessCategory,
                        companyId: company.id,
                        isGlobalAccess: false,
                      }),
                    );

                    if (parentToChildAccesses.length > 0) {
                      await tx.userAccess.createMany({
                        data: parentToChildAccesses,
                        skipDuplicates: true,
                      });
                    }
                  }
                }

              }
            }
          }

          // 4. Update request status to fully APPROVED
          await tx.userOnboarding.update({
            where: { id },
            data: {
              status: 'APPROVED',
              approvalRemark: remark,
            },
          });

          return { status: 'APPROVED' };
        }

        // =========================
        // ❌ REJECTED FLOW
        // =========================
        else if (statusStr === 'reject' || statusStr === 'rejected') {
          // Reject all remaining approval levels
          await WorkflowApproverUtil.rejectAllLevels(tx, id, 'user_onboarding');

          const updated = await tx.userOnboarding.update({
            where: { id },
            data: {
              status: 'REJECTED',
              approvalRemark: remark,
            },
          });

          const userEmail =
            updated.type && updated.type !== 'INITIATE'
              ? (updated.data as any)?.targetUserEmail
              : (updated.data as any)?.basicDetails?.email;

          if (approverId && userEmail) {
            await tx.userHistory.create({
              data: {
                email: userEmail,
                event: 'REJECTED',
                eventUserId: approverId,
                companyId: onboarding.companyId,
                reqId: id,
                level: currentLevel?.level || null,
                remarks: remark,
              },
            });
          }

          return { status: 'REJECTED' };
        }

        // =========================
        // ⚠️ INVALID STATUS
        // =========================
        else {
          throw new AppError('Invalid status', 400);
        }
      });

      const requestType = String(onboarding.type || 'INITIATE').toUpperCase();
      let message = `User request ${status.toLowerCase()}d successfully`;
      if (result && result.status === 'PARTIAL_APPROVED') {
        message = `User request approved at Level ${result.level}, pending remaining approval`;
        notificationRecipients =
          await NotificationService.getCurrentApproverIds(
            id,
            'user_onboarding',
            notificationRecipients,
          );
      } else if (result && result.status === 'APPROVED') {
        if (requestType === 'INITIATE') {
          message = 'User onboarding request approved and user onboarded';
        } else if (requestType === 'UPDATE') {
          message = 'User update request approved';
        } else if (requestType === 'ACTIVE') {
          message = 'User activation request approved';
        } else if (requestType === 'INACTIVE') {
          message = 'User inactivation request approved';
        } else if (requestType === 'ARCHIVE') {
          message = 'User archive request approved';
        }
      } else if (result && result.status === 'REJECTED') {
        message = `User ${requestType.toLowerCase()} request rejected`;
      }

      const requestInitiatorId =
        await NotificationService.getRequestInitiatorId(id, 'user_onboarding');
      const notificationRecipientUserIds =
        NotificationService.mergeRecipientUserIds(
          notificationRecipients,
          requestInitiatorId,
        );
      const corpAdminUserIds = await NotificationService.getCorpAdminUserIds(
        onboarding.companyId,
      );
      const notificationLookupEmail =
        result?.status === 'REJECTED' ? historyEmail : email || historyEmail;
      const notificationUser = notificationLookupEmail
        ? await prisma.user.findUnique({
          where: { email: notificationLookupEmail },
          select: { name: true, email: true },
        })
        : null;
      const notificationReferenceName = UserDbController.formatUserReferenceName(
        {
          name: name || notificationUser?.name,
          email: notificationLookupEmail || notificationUser?.email,
        },
      );
      const userNotificationContent =
        requestType !== 'INITIATE' && result?.status
          ? UserDbController.getUserNotificationContent(
            requestType,
            result.status === 'REJECTED' ? 'rejected' : 'approved',
            notificationReferenceName,
          )
          : null;

      await NotificationService.createRequestNotification({
        companyId: onboarding.companyId,
        type: UserDbController.getUserNotificationType(
          onboarding.type,
          result?.status,
        ),
        ...(userNotificationContent || {}),
        referenceType: 'USER',
        referenceId: id,
        referenceName: notificationReferenceName,
        createdBy: approverId,
        recipientUserIds: NotificationService.mergeRecipientUserIds(
          notificationRecipientUserIds,
          corpAdminUserIds,
        ),
        requiredRecipientUserIds: NotificationService.mergeRecipientUserIds(
          requestInitiatorId,
        ),
        isPending: result?.status === 'PARTIAL_APPROVED',
      });

      res.status(200).json({
        message,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Fetches the audit trail for a specific user within a company.
   */
  static async getUserHistory(req: Request, res: Response, next: NextFunction) {
    try {
      const { email, companyCode, companyId, userId: viewerUserId } = req.body;
      let resolvedCompanyId = companyId;

      if (!resolvedCompanyId) {
        if (!companyCode) {
          throw new AppError('companyCode or companyId is required', 400);
        }
        const company = await prisma.company.findUnique({
          where: { companyCode },
        });
        if (!company) throw new AppError('Company not found', 404);
        resolvedCompanyId = company.id;
      }

      const history = await prisma.userHistory.findMany({
        where: {
          email,
          companyId: resolvedCompanyId,
        },
        include: {
          user: {
            include: {
              userMappings: {
                where: { companyId: resolvedCompanyId },
              },
              userAccesses: {
                where: { companyId: resolvedCompanyId },
              },
            },
          },
          company: { select: { companyCode: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      // 1. Collect all unique request IDs to fetch their workflow approval status
      const reqIds = Array.from(
        new Set(history.map((h) => h.reqId).filter(Boolean)),
      ) as string[];

      const [workflowApprovers, requestSnapshots] = await Promise.all([
        prisma.workflowApprover.findMany({
          where: { reqId: { in: reqIds } },
          orderBy: { level: 'asc' },
        }),
        reqIds.length > 0
          ? prisma.userOnboarding.findMany({
            where: { id: { in: reqIds } },
            select: { id: true, data: true, oldData: true, type: true, impact: true },
          })
          : Promise.resolve([]),
      ]);
      const requestSnapshotMap = new Map(
        requestSnapshots.map((request) => [request.id, request]),
      );

      // Group workflow levels by reqId
      const workflowMap = new Map<string, any[]>();
      workflowApprovers.forEach((wa) => {
        const existing = workflowMap.get(wa.reqId) || [];
        existing.push(wa);
        workflowMap.set(wa.reqId, existing);
      });

      const rejectedReqIds = new Set<string>();
      for (const [reqId, levels] of workflowMap.entries()) {
        if (levels.some((l: any) => l.status === 'REJECTED')) {
          rejectedReqIds.add(reqId);
        }
      }
      history.forEach((h) => {
        if (h.reqId && h.event === 'REJECTED') {
          rejectedReqIds.add(h.reqId);
        }
      });

      const activeHistory = history.filter(
        (h) => !h.reqId || !rejectedReqIds.has(h.reqId),
      );

      // Build request-level maps used to filter displayed approvers.
      const initiatorMap = new Map<string, string>();
      const approvedUserMap = new Map<string, Set<string>>();
      activeHistory.forEach((h) => {
        if (h.reqId) {
          if (h.event === 'INITIATE' && h.eventUserId) {
            initiatorMap.set(h.reqId, h.eventUserId);
          }
          if (h.event === 'APPROVED' && h.eventUserId) {
            const approvedUsers =
              approvedUserMap.get(h.reqId) || new Set<string>();
            approvedUsers.add(h.eventUserId);
            approvedUserMap.set(h.reqId, approvedUsers);
          }
        }
      });
      // console.log(`[UserHistory] Built initiatorMap with ${initiatorMap.size} entries`);

      // Filter each stored approver list for active display only. The DB row is not mutated.
      for (const [reqId, levels] of workflowMap.entries()) {
        if (rejectedReqIds.has(reqId)) continue; // skip enriching rejected workflows
        const initiatorId = initiatorMap.get(reqId) || null;
        const approvedUserIds = Array.from(
          approvedUserMap.get(reqId) ?? new Set<string>(),
        );
        for (const level of levels) {
          const storedList = Array.isArray(level.approversList)
            ? (level.approversList as string[])
            : [];
          level.approversList =
            await WorkflowApproverUtil.getEnrichedApproverIds(
              resolvedCompanyId,
              storedList,
              initiatorId,
              'USER_ACC',
              approvedUserIds,
            );
        }
      }

      // 2. Resolve approver details (names/emails) from enriched lists
      const allApproverIds = new Set<string>();
      for (const levels of workflowMap.values()) {
        for (const level of levels) {
          (level.approversList as string[]).forEach((id: string) =>
            allApproverIds.add(id),
          );
        }
      }

      const approverDetails = await prisma.user.findMany({
        where: { id: { in: Array.from(allApproverIds) } },
        select: {
          id: true,
          name: true,
          email: true,
        },
      });

      const saasAdminUserIds = await HistoryUserUtil.getSaasAdminUserIds([
        viewerUserId,
        ...Array.from(allApproverIds),
        ...activeHistory.map((h) => h.eventUserId),
      ]);

      const approverMap = new Map(
        approverDetails.map((u) => [
          u.id,
          HistoryUserUtil.formatAuditUser(
            u,
            u.id,
            saasAdminUserIds,
            viewerUserId,
          ),
        ]),
      );

      const resultList: any[] = [];
      const handledPendingReqs = new Set<string>();

      // 3. Inject "Pending Approval" entries for any active requests
      activeHistory.forEach((h) => {
        if (h.reqId && !handledPendingReqs.has(h.reqId)) {
          const levels = workflowMap.get(h.reqId);
          if (levels) {
            const currentPending = levels.find((l) => l.status === 'PENDING');
            if (currentPending) {
              const requestSnapshot = requestSnapshotMap.get(h.reqId);
              const changeCount = UserDbController.getUserHistoryChangeCount(
                requestSnapshot?.data,
                requestSnapshot?.oldData,
                requestSnapshot?.type,
              );
              const approvers = (currentPending.approversList as string[])
                .map((id) => {
                  const u = approverMap.get(id);
                  return u ? { name: u.name, email: u.email } : null;
                })
                .filter(Boolean);

              resultList.push({
                id: h.id,
                email: h.email,
                type: requestSnapshotMap.get(h.reqId)?.type || null,
                impact: requestSnapshotMap.get(h.reqId)?.impact || null,
                companyCode: h.company.companyCode,
                oldData:
                  requestSnapshotMap.get(h.reqId)?.oldData ||
                  ((requestSnapshotMap.get(h.reqId)?.data as any)?.oldData ??
                    null),
                newData: requestSnapshotMap.get(h.reqId)?.data || null,
                changeCount,
                event: `L${currentPending.level} Pending Approval`,
                createdAt: null,
                eligibleapprovers: approvers,
              });
            }
          }
          handledPendingReqs.add(h.reqId);
        }
      });

      // 4. Add actual history entries
      const formattedHistory = activeHistory.map((h) => {
        const requestType = h.reqId
          ? (requestSnapshotMap.get(h.reqId)?.type || null)
          : null;
        const changeCount = h.reqId
          ? UserDbController.getUserHistoryChangeCount(
            requestSnapshotMap.get(h.reqId)?.data,
            requestSnapshotMap.get(h.reqId)?.oldData,
            requestType,
          )
          : { added: 0, modify: 0, remove: 0 };
        const displayEvent =
          h.event === 'INITIATE' &&
            requestType &&
            requestType !== 'INITIATE'
            ? 'MODIFY'
            : h.event;
        const levels = h.reqId ? workflowMap.get(h.reqId) : null;
        let workflowStatus = null;

        if (levels && levels.length > 0) {
          const allApproved = levels.every((l: any) => l.status === 'APPROVED');
          const isRejected = levels.some((l: any) => l.status === 'REJECTED');
          const currentPending = levels.find(
            (l: any) => l.status === 'PENDING',
          );

          workflowStatus = {
            overallStatus: isRejected
              ? 'REJECTED'
              : allApproved
                ? 'APPROVED'
                : 'PENDING',
            currentLevel: currentPending
              ? currentPending.level
              : allApproved
                ? levels.length
                : null,
            totalLevels: levels.length,
            levels: levels
              .filter(
                (l: any) => l.level <= (currentPending?.level || levels.length),
              )
              .map((l: any) => ({
                level: l.level,
                status: l.status,
                eligibleapprovers: (l.approversList as string[])
                  .map((id: string) => {
                    const u = approverMap.get(id);
                    return u ? { name: u.name, email: u.email } : null;
                  })
                  .filter(Boolean),
              })),
          };
        }

        return {
          id: h.id,
          email: h.email,
          type: requestType,
          impact: h.reqId ? (requestSnapshotMap.get(h.reqId)?.impact || null) : null,
          companyCode: h.company.companyCode,
          oldData: h.reqId
            ? requestSnapshotMap.get(h.reqId)?.oldData ||
            ((requestSnapshotMap.get(h.reqId)?.data as any)?.oldData ?? null)
            : null,
          newData: h.reqId ? (requestSnapshotMap.get(h.reqId)?.data || null) : null,
          event: displayEvent,
          level: h.level,
          createdAt: h.createdAt,
          remarks: h.remarks,
          changeCount,
          user: HistoryUserUtil.formatAuditUser(
            h.user,
            h.eventUserId,
            saasAdminUserIds,
            viewerUserId,
          ),
        };
      });

      resultList.push(...formattedHistory);

      res.status(200).json({
        message: 'User history fetched successfully!',
        code: 200,
        data: resultList,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Fetches a single user history event with its resolved request snapshot.
   */
  static async getUserHistoryDetail(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { id, companyId, companyCode, userId: viewerUserId } = req.body;

      if (!id) {
        throw new AppError('History id is required', 400);
      }

      let resolvedCompanyId = companyId;
      if (!resolvedCompanyId) {
        if (!companyCode) {
          throw new AppError('companyCode or companyId is required', 400);
        }
        const company = await prisma.company.findUnique({
          where: { companyCode },
          select: { id: true },
        });
        if (!company) throw new AppError('Company not found', 404);
        resolvedCompanyId = company.id;
      }

      const history = await prisma.userHistory.findFirst({
        where: {
          id,
          companyId: resolvedCompanyId,
        },
        include: {
          user: {
            include: {
              userMappings: {
                where: { companyId: resolvedCompanyId },
              },
              userAccesses: {
                where: { companyId: resolvedCompanyId },
              },
            },
          },
          company: { select: { companyCode: true, id: true } },
        },
      });

      if (!history) {
        throw new AppError('User history not found', 404);
      }

      const onboarding = history.reqId
        ? await prisma.userOnboarding.findFirst({
          where: { id: history.reqId, companyId: resolvedCompanyId },
          select: {
            id: true,
            data: true,
            oldData: true,
            type: true,
            impact: true,
            status: true,
            workflowId: true,
            approvalRemark: true,
            createdAt: true,
          },
        })
        : null;
      const requestData = (onboarding?.data as any) || null;
      const requestType = String(onboarding?.type || 'INITIATE').toUpperCase();

      const allRequests = await prisma.userOnboarding.findMany({
        where: { companyId: resolvedCompanyId },
        select: {
          id: true,
          data: true,
          oldData: true,
          type: true,
          status: true,
          createdAt: true,
        },
      });
      const replay = UserDbController.buildUserSnapshotAroundRequest(
        allRequests,
        onboarding?.id,
      );
      let oldData = replay.oldData;
      let newData = replay.newData;

      const fallbackSnapshot = UserDbController.extractUserSnapshot(requestData);
      if (!newData) {
        newData = fallbackSnapshot;
      }
      const changeCount = UserDbController.getUserHistoryChangeCount(
        requestData,
        oldData,
        requestType,
      );

      const saasAdminUserIds = await HistoryUserUtil.getSaasAdminUserIds([
        viewerUserId,
        history.eventUserId,
      ]);

      const displayEvent =
        history.event === 'INITIATE' && requestType !== 'INITIATE'
          ? 'MODIFY'
          : history.event;

      res.status(200).json({
        message: 'User history item fetched successfully!',
        code: 200,
        data: {
          id: history.id,
          reqId: history.reqId,
          companyCode: history.company.companyCode,
          type: onboarding?.type || null,
          impact: onboarding?.impact || null,
          event: displayEvent,
          rawEvent: history.event,
          level: history.level,
          createdAt: history.createdAt,
          remarks: history.remarks,
          changeCount,
          oldData,
          newData,
          user: HistoryUserUtil.formatAuditUser(
            history.user,
            history.eventUserId,
            saasAdminUserIds,
            viewerUserId,
          ),
          request: onboarding
            ? {
              id: onboarding.id,
              type: onboarding.type,
              status: onboarding.status,
              workflowId: onboarding.workflowId,
              approvalRemark: onboarding.approvalRemark,
              createdAt: onboarding.createdAt,
            }
            : null,
        },
      });
    } catch (error) {
      const initiatorId = req.body?.initiatorId;
      let resolvedCompanyId = req.body?.companyId as string | undefined;
      if (!resolvedCompanyId && typeof req.body?.companyCode === 'string') {
        const company = await prisma.company.findUnique({
          where: { companyCode: req.body.companyCode },
          select: { id: true },
        });
        resolvedCompanyId = company?.id;
      }

      const requestId = req.body?.id;
      if (
        typeof initiatorId === 'string' &&
        typeof resolvedCompanyId === 'string' &&
        typeof requestId === 'string'
      ) {
        const requestInitiatorId =
          await NotificationService.getRequestInitiatorId(
            requestId,
            'user_onboarding',
          );
        const requestApproverIds =
          await NotificationService.getRequestApproverIds(
            requestId,
            'user_onboarding',
          );
        const corpAdminUserIds = await NotificationService.getCorpAdminUserIds(
          resolvedCompanyId,
        );
        const recipients = NotificationService.mergeRecipientUserIds(
          requestInitiatorId || initiatorId,
          requestApproverIds,
          corpAdminUserIds,
        );

        await NotificationService.createRequestNotification({
          companyId: resolvedCompanyId,
          type: 'MODIFICATION',
          name: 'User request failed',
          message: `User request failed: ${error instanceof Error ? error.message : 'Unexpected error'
            }`,
          referenceType: 'USER',
          referenceId: requestId,
          referenceName:
            req.body?.targetEmail ||
            req.body?.targetUserEmail ||
            req.body?.data?.basicDetails?.email ||
            'user',
          createdBy: requestInitiatorId || initiatorId,
          recipientUserIds: recipients,
          requiredRecipientUserIds: NotificationService.mergeRecipientUserIds(
            requestInitiatorId || initiatorId,
            requestApproverIds,
          ),
          includeCreatedBy: true,
          isPending: false,
        });
      }
      next(error);
    }
  }

  /**
   * Utility to check if a user already has a pending onboarding request by email.
   * Prevents multiple submissions for the same email.
   */
  static async getPendingUsers(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { email } = req.body;
      const user = await prisma.userOnboarding.findFirst({
        where: {
          status: 'PENDING',
          data: {
            path: ['basicDetails', 'email'],
            equals: email,
          },
        },
      });
      res.status(200).json(user);
    } catch (error) {
      next(error);
    }
  }
  /**
   * Fetches organizational nodes for a user based on global status and sub-category.
   */
  static async fetchCompanyNodes(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { userId, companyId, subCategory } = req.body;
      const workflowSubCategory =
        UserDbController.normalizeFilterText(subCategory);
      const [pendingOrgNodePaths, pendingWorkflowKeys] = await Promise.all([
        UserDbController.getPendingOrgNodePathsForFetch(companyId),
        UserDbController.getPendingWorkflowKeysForFetch(companyId),
      ]);

      const userMapping = await prisma.userMapping.findUnique({
        where: {
          userId_companyId: {
            userId,
            companyId,
          },
        },
        select: { designation: true },
      });

      const designation = userMapping?.designation || '';

      const globalAccess = await prisma.userAccess.findFirst({
        where: {
          userId,
          companyId,
          isGlobalAccess: true,
        },
        include: {
          role: {
            select: {
              roleName: true,
            },
          },
        },
      });

      const defaultWorkflow = await UserDbController.fetchDefaultWorkflowOption(
        companyId,
        workflowSubCategory,
      );
      const visibleDefaultWorkflow =
        defaultWorkflow &&
          !pendingWorkflowKeys.has(
            UserDbController.workflowIdentityKey({
              module: defaultWorkflow.module,
              subModule: defaultWorkflow.subModule,
              nodePath: defaultWorkflow.nodePath,
              levelsHash: defaultWorkflow.levelsHash,
            }) || '',
          )
          ? defaultWorkflow
          : null;

      if (globalAccess) {
        const companyNodes = await prisma.orgStructure.findMany({
          where: {
            companyId,
            status: 'ACTIVE',
            nodePath: { notIn: Array.from(pendingOrgNodePaths) },
          },
          select: {
            nodeName: true,
            nodePath: true,
            nodeType: true,
            status: true,
            workflows: {
              where: {
                ...(workflowSubCategory
                  ? { subModule: workflowSubCategory }
                  : {}),
                status: 'ACTIVE',
                orgStructure: { status: 'ACTIVE' },
              },
              select: {
                id: true,
                module: true,
                subModule: true,
                levelsHash: true,
                name: true,
                alias: true,
                status: true,
              },
            },
          },
        });

        const nodes = companyNodes.map((node) => {
          const nodeWithWorkflows = UserDbController.withDefaultWorkflowOption(
            {
              ...node,
              workflows: node.workflows.filter(
                (workflow) =>
                  !pendingWorkflowKeys.has(
                    UserDbController.workflowIdentityKey({
                      module: workflow.module,
                      subModule: workflow.subModule,
                      nodePath: node.nodePath,
                      levelsHash: workflow.levelsHash,
                    }) || '',
                  ),
              ),
            },
            visibleDefaultWorkflow,
          );

          return {
            ...nodeWithWorkflows,
            workflows: nodeWithWorkflows.workflows.map((workflow: any) => ({
              levelsHash: workflow.levelsHash,
              name: workflow.name,
              alias: workflow.alias,
              status: workflow.status,
            })),
            roleName: globalAccess.role?.roleName || globalAccess.roleCode,
          };
        });

        return res.status(200).json({
          nodes,
        });
      } else {
        if (!workflowSubCategory) {
          return res.status(200).json([]);
        }

        const userAccesses = await prisma.userAccess.findMany({
          where: {
            userId,
            companyId,
            orgStructure: {
              status: 'ACTIVE',
              nodePath: { notIn: Array.from(pendingOrgNodePaths) },
            },
            role: {
              subCategory: workflowSubCategory,
            },
          },
          include: {
            role: {
              select: {
                roleName: true,
              },
            },
            orgStructure: {
              select: {
                nodeName: true,
                nodePath: true,
                nodeType: true,
                status: true,
                workflows: {
                  where: {
                    subModule: workflowSubCategory,
                    status: 'ACTIVE',
                    orgStructure: { status: 'ACTIVE' },
                  },
                  select: {
                    id: true,
                    module: true,
                    subModule: true,
                    levelsHash: true,
                    name: true,
                    alias: true,
                    status: true,
                  },
                },
              },
            },
          },
        });

        const nodes = userAccesses
          .map((ua) => {
            const nodeWithWorkflows = UserDbController.withDefaultWorkflowOption(
              {
                ...ua.orgStructure,
                workflows: ua.orgStructure.workflows.filter(
                  (workflow) =>
                    !pendingWorkflowKeys.has(
                      UserDbController.workflowIdentityKey({
                        module: workflow.module,
                        subModule: workflow.subModule,
                        nodePath: ua.orgStructure.nodePath,
                        levelsHash: workflow.levelsHash,
                      }) || '',
                    ),
                ),
              },
              visibleDefaultWorkflow,
            );

            return {
              ...nodeWithWorkflows,
              workflows: nodeWithWorkflows.workflows.map((workflow: any) => ({
                levelsHash: workflow.levelsHash,
                name: workflow.name,
                alias: workflow.alias,
                status: workflow.status,
              })),
              roleName: ua.role?.roleName || ua.roleCode,
            };
          })
          .filter(
            (node, index, self) =>
              index === self.findIndex((t) => t.nodePath === node.nodePath),
          );

        return res.status(200).json({
          nodes,
        });
      }
    } catch (error) {
      next(error);
    }
  }

  /**
   * Counts unique users assigned to a specific node path for a company, grouped by subCategory.
   */
  static async fetchUsersByNodePathCount(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { nodePath, companyId } = req.body;

      if (!nodePath) {
        throw new AppError('Node path is required', 400);
      }

      // Fetch all user accesses for this node path, including their roles
      const userAccesses = await prisma.userAccess.findMany({
        where: {
          orgStructure: {
            nodePath: nodePath,
            status: 'ACTIVE',
          },
          ...(companyId ? { companyId } : {}),
        },
        include: {
          role: true,
        },
      });

      // Group unique user IDs by subCategory and permissionLevel
      const countsMap: Record<
        string,
        { MANAGER: Set<string>; USER: Set<string>; VIEWER: Set<string> }
      > = {};

      userAccesses.forEach((ua) => {
        const subCat = ua.role?.subCategory;
        const pLevel = ua.role?.permissionLevel?.toUpperCase();

        if (
          subCat &&
          pLevel &&
          (pLevel === 'MANAGER' || pLevel === 'USER' || pLevel === 'VIEWER')
        ) {
          if (!countsMap[subCat]) {
            countsMap[subCat] = {
              MANAGER: new Set(),
              USER: new Set(),
              VIEWER: new Set(),
            };
          }
          countsMap[subCat][pLevel as 'MANAGER' | 'USER' | 'VIEWER'].add(
            ua.userId,
          );
        }
      });

      // Transform the map into the desired response format and filter out zero-count sub-categories
      const finalData: Record<string, any> = {};

      Object.entries(countsMap).forEach(([subCat, levels]) => {
        const managerCount = levels.MANAGER.size;
        const userCount = levels.USER.size;
        const viewerCount = levels.VIEWER.size;

        // Only include sub-categories that have at least one user in any level
        if (managerCount > 0 || userCount > 0 || viewerCount > 0) {
          finalData[subCat] = [
            {
              label: 'Checker',
              count: managerCount,
              permissionlevel: 'MANAGER',
            },
            {
              label: 'Maker',
              count: userCount,
              permissionlevel: 'USER',
            },
            {
              label: 'Viewer',
              count: viewerCount,
              permissionlevel: 'VIEWER',
            },
          ];
        }
      });

      res.status(200).json({
        message: 'User counts fetched successfully!',
        code: 200,
        data: finalData,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Verifies if a user has global access permissions within a company.
   */
  static async checkGlobalUserStatus(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { userId, companyId } = req.body;

      const globalAccess = await prisma.userAccess.findFirst({
        where: {
          userId,
          companyId,
          isGlobalAccess: true,
        },
        include: {
          orgStructure: true,
        },
      });

      res.status(200).json({ isGlobal: !!globalAccess, globalAccess });
    } catch (error) {
      next(error);
    }
  }
}
