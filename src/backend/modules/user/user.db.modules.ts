import type { Request, Response, NextFunction } from 'express';
import { prisma, ltree } from '../../lib/prisma';
import { HashUtil } from '../../../shared/utils/hash.util';
import { AppError } from '../../middlewares/error.middleware';
import { getPagination } from '../../../shared/utils/pagination.util';
import { WorkflowApproverUtil } from '../../utils/workflow-approver.util';
import { NotificationService } from '../notifications/notification.db.modules';
import { HistoryUserUtil } from '../../utils/history-user.util';
import { buildJsonPatch, cloneJson } from '../../utils/json-patch.util';

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

type CompanyNodeFilterDesignationOption = {
  value: string;
  count: number;
};

type CompanyNodeFilterNodeTypeOption = {
  value: string;
  count: number;
};

type CompanyNodeFilterNodeOption = {
  value: string;
  path: string;
  nodeType?: string | null;
  count?: number;
  level?: number;
  levelCount?: string | number;
  permissionCount?: number;
};

type CompanyNodeFilterUserStatusSummary = {
  active: number;
  pending: number;
  inactive: number;
};

type CompanyNodeFilterPermissionSummaryItem = {
  count: number;
};

type CompanyNodeFilterPermissionSummary = {
  checker: CompanyNodeFilterPermissionSummaryItem;
  maker: CompanyNodeFilterPermissionSummaryItem;
  viewer: CompanyNodeFilterPermissionSummaryItem;
  corpAdmin: CompanyNodeFilterPermissionSummaryItem;
};

type CompanyWorkflowFilterApplied = {
  nodeValues: string[];
  nodeType: string[];
  module: string[];
  subCategory: string[];
  checkerCounts: number[];
  workflowLevels: number[];
  levels: string[];
};

type UserAccessVisibilityNode = {
  id: string;
  nodeName: string;
  nodePath: string;
  nodeType: string;
};

type UserAccessVisibilityScope = {
  isGlobal: boolean;
  visibleNodeIds: string[];
  visibleNodePaths: string[];
  visibleNodes: UserAccessVisibilityNode[];
};

type FetchUserViewerScope = {
  isSaasAdmin: boolean;
  isCorpAdmin: boolean;
  isGlobal: boolean;
  visibleNodeIds: string[];
  visibleNodePaths: string[];
};

type PendingApprovalEligibleUserSummary = {
  count: number;
  subCategories: Set<'USER_ACC' | 'ORG_STR' | 'WORK_FLOW'>;
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

type NormalizedUserListAppliedFilters = {
  designation: string[];
  nodeValues: string[];
  nodeAccess: Record<string, string[]>;
  nodeType: string[];
  category: string[];
  subCategory: string[];
  reportingManager: string[];
  status: string[];
  role: string[];
  currentStatus: 'INITIATE' | 'MODIFY' | null;
  hasPending: boolean | null;
  onboardingDate: {
    from: Date | null;
    to: Date | null;
  } | null;
};

/**
 * Controller for managing user accounts, mappings to companies, and onboarding workflows.
 * Handles production user data and pending user requests.
 */
export class UserDbController {
  private static isAutoOrgUserAccessHistoryType(
    requestType: string | null | undefined,
  ) {
    const normalizedType = String(requestType || '').toUpperCase();
    return (
      normalizedType === 'AUTO_GENERATE' || normalizedType === 'AUTO_DELETE'
    );
  }

  private static getUserHistoryDisplayEvent(
    event: string | null | undefined,
    requestType: string | null | undefined,
  ) {
    const normalizedEvent = String(event || '').toUpperCase();
    if (normalizedEvent !== 'INITIATE') return normalizedEvent || event;

    const normalizedType = String(requestType || 'INITIATE').toUpperCase();
    if (normalizedType === 'UPDATE') return 'MODIFY';
    if (UserDbController.isAutoOrgUserAccessHistoryType(normalizedType)) {
      return 'MODIFY';
    }
    if (normalizedType === 'ACTIVE') return 'ACTIVE';
    if (normalizedType === 'INACTIVE') return 'INACTIVE';
    if (normalizedType === 'ARCHIVE') return 'ARCHIVE';

    return 'INITIATE';
  }

  private static resolveUserHistoryRequestType(
    request:
      | {
          type?: string | null;
          impact?: string | null;
          data?: unknown;
        }
      | null
      | undefined,
  ) {
    const normalizedImpact = String(request?.impact || '').toUpperCase();
    if (
      normalizedImpact === 'ACTIVE' ||
      normalizedImpact === 'INACTIVE' ||
      normalizedImpact === 'ARCHIVE'
    ) {
      return normalizedImpact;
    }

    const requestData = request?.data as any;
    const normalizedStatus = String(
      requestData?.basicDetails?.status || requestData?.status || '',
    ).toUpperCase();
    const normalizedType = String(request?.type || 'INITIATE').toUpperCase();
    if (
      normalizedType === 'UPDATE' &&
      (normalizedStatus === 'ACTIVE' ||
        normalizedStatus === 'INACTIVE' ||
        normalizedStatus === 'ARCHIVE')
    ) {
      return normalizedStatus;
    }

    return normalizedType || 'INITIATE';
  }

  private static isUserModificationHistoryType(
    requestType: string | null | undefined,
  ) {
    const normalizedType = String(requestType || 'INITIATE').toUpperCase();
    return (
      normalizedType === 'UPDATE' ||
      UserDbController.isAutoOrgUserAccessHistoryType(normalizedType)
    );
  }

  private static pathsOverlap(left: string, right: string) {
    return (
      left === right ||
      left.startsWith(`${right}.`) ||
      right.startsWith(`${left}.`)
    );
  }

  private static doesAccessCoverNode(
    access: {
      isGlobalAccess?: boolean | null;
      accessCategory?: string | null;
      orgStructure?: { nodePath?: string | null } | null;
    },
    targetNodePath: string,
  ) {
    if (access.isGlobalAccess) {
      return true;
    }

    const accessNodePath =
      typeof access.orgStructure?.nodePath === 'string'
        ? access.orgStructure.nodePath.trim()
        : '';
    if (!accessNodePath) {
      return false;
    }

    const normalizedCategory = String(access.accessCategory || 'NODE')
      .trim()
      .toUpperCase();

    if (targetNodePath === accessNodePath) {
      return true;
    }

    if (normalizedCategory === 'ALL_CHILD') {
      return targetNodePath.startsWith(`${accessNodePath}.`);
    }

    if (normalizedCategory === 'IMMEDIATE_CHILD') {
      const parentPath = targetNodePath.split('.').slice(0, -1).join('.');
      return parentPath === accessNodePath;
    }

    return false;
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
    reportingManagerUserIds: string[] = [],
  ) {
    const corpAdminUserIds =
      await NotificationService.getCorpAdminUserIds(companyId);
    const recipients = NotificationService.mergeRecipientUserIds(
      initiatorId,
      approverUserIds,
      reportingManagerUserIds,
      corpAdminUserIds,
    );
    await NotificationService.createRequestNotification({
      companyId,
      type: 'MODIFICATION',
      name: 'User modification failed',
      message: `${message}`,
      referenceType: 'USER',
      referenceName,
      createdBy: initiatorId,
      recipientUserIds: recipients,
      requiredRecipientUserIds: NotificationService.mergeRecipientUserIds(
        initiatorId,
        approverUserIds,
        reportingManagerUserIds,
      ),
      includeCreatedBy: true,
      isPending: false,
    });
  }

  private static async getReportingManagerUserIds(
    companyId: string,
    userId?: string | null,
    reportingManagerEmail?: string | null,
  ) {
    let managerEmail = String(reportingManagerEmail || '').trim();

    if (!managerEmail && userId) {
      const mapping = await prisma.userMapping.findFirst({
        where: {
          companyId,
          userId,
        },
        include: {
          manager: {
            select: { email: true },
          },
        },
      });
      managerEmail = String(mapping?.manager?.email || '').trim();
    }

    if (!managerEmail) return [];

    const manager = await prisma.user.findUnique({
      where: { email: managerEmail },
      select: { id: true },
    });

    return manager?.id ? [manager.id] : [];
  }

  private static async getCompanyMappedUserNotificationRecipientIds(
    companyId: string,
    options: {
      userId?: string | null;
      email?: string | null;
    } = {},
  ) {
    const normalizedUserId =
      typeof options.userId === 'string' ? options.userId.trim() : '';
    if (normalizedUserId) {
      const mapping = await prisma.userMapping.findFirst({
        where: {
          companyId,
          userId: normalizedUserId,
        },
        select: { userId: true },
      });
      return mapping?.userId ? [mapping.userId] : [];
    }

    const normalizedEmail =
      typeof options.email === 'string' ? options.email.trim() : '';
    if (!normalizedEmail) return [];

    const user = await prisma.user.findFirst({
      where: {
        email: normalizedEmail,
        userMappings: {
          some: {
            companyId,
          },
        },
      },
      select: { id: true },
    });

    return user?.id ? [user.id] : [];
  }

  private static async getCompanySaasAdminUserIds(companyId: string) {
    const accesses = await prisma.userAccess.findMany({
      where: {
        companyId,
        roleCode: 'SAAS_ADMIN',
        user: {
          userMappings: {
            some: {
              companyId,
              status: 'ACTIVE',
            },
          },
        },
      },
      select: { userId: true },
    });

    return Array.from(
      new Set(
        accesses
          .map((access) => String(access.userId || '').trim())
          .filter(Boolean),
      ),
    );
  }

  private static buildNotificationHandledError(
    message: string,
    statusCode = 400,
  ) {
    const error = new AppError(message, statusCode);
    (error as any).skipConflictNotification = true;
    return error;
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

  private static getUserPendingApprovalNotificationContent(
    type: string | null | undefined,
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
      name: `${label} approval pending`,
      message: `${label} request is pending for your approval for ${referenceName}`,
    };
  }

  private static getUserLevelApprovalNotificationContent(
    type: string | null | undefined,
    referenceName: string,
    level: number | null | undefined,
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
    const levelLabel =
      typeof level === 'number' && Number.isFinite(level)
        ? ` at Level ${level}`
        : '';

    return {
      name: `${label} approved${levelLabel}`,
      message: `${label} request approved${levelLabel} for ${referenceName}`,
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
      typeof permission?.roleName === 'string'
        ? permission.roleName.trim()
        : '';
    const nodePath =
      typeof permission?.nodePath === 'string'
        ? permission.nodePath.trim()
        : '';
    return `${roleName}|${nodePath}`;
  }

  private static formatInitiatePermissionSummary(
    originalPermissions: any[],
    expandedPermissions: any[],
  ) {
    if (
      !Array.isArray(expandedPermissions) ||
      expandedPermissions.length === 0
    ) {
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

  private static getEmptyUserHistoryApprovalSummary() {
    return {
      currentStatus: null,
      totalLevels: 0,
      completedLevels: 0,
      rejectedAtLevel: null,
      currentPendingLevel: null,
    };
  }

  private static getUserHistoryLevelCount(
    displayEvent: string,
    options: {
      approvalLevel?: number | null;
      approvalStep?: number | null;
      isChangeRequestStart?: boolean;
      modificationSequence?: number | null;
    } = {},
  ) {
    if (options.isChangeRequestStart) {
      return `M${options.modificationSequence || 1}`;
    }

    if (displayEvent === 'INITIATE') return 'I';
    if (displayEvent === 'APPROVED') {
      const step = options.approvalStep ?? options.approvalLevel;
      if (step) return `A${step}`;
    }
    if (displayEvent === 'REJECTED') {
      const step = options.approvalStep ?? options.approvalLevel;
      if (step) return `R${step}`;
    }
    if (displayEvent === 'ACTIVE') return 'AC';
    if (displayEvent === 'INACTIVE') return 'IN';
    if (displayEvent === 'ARCHIVE') return 'AR';

    return null;
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

  private static getUserHistoryChangeCountFromPermissionDiff(
    requestData: any,
    oldData: any,
  ): HistoryChangeCount | null {
    const permissions = oldData?.permissions;
    if (
      !permissions ||
      typeof permissions !== 'object' ||
      Array.isArray(permissions)
    ) {
      return null;
    }

    const removedPermissions = Array.isArray(permissions.removed)
      ? permissions.removed
      : [];
    const updatedPermissions = Array.isArray(permissions.updated)
      ? permissions.updated
      : [];
    if (removedPermissions.length === 0 && updatedPermissions.length === 0) {
      return null;
    }

    const updatedKeys = new Set(
      updatedPermissions.map((permission: any) =>
        UserDbController.permissionReplacementKey(
          UserDbController.normalizePermission(permission),
        ),
      ),
    );
    const removedKeys = new Set(
      removedPermissions.map((permission: any) =>
        UserDbController.permissionReplacementKey(
          UserDbController.normalizePermission(permission),
        ),
      ),
    );
    const counts: HistoryChangeCount = {
      added: 0,
      modify: updatedPermissions.length,
      remove: removedPermissions.length,
    };
    const mutations = Array.isArray(requestData?.permissions)
      ? requestData.permissions
      : [];

    for (const mutation of mutations) {
      if (UserDbController.isPermissionRemoval(mutation)) {
        continue;
      }

      const key = UserDbController.permissionReplacementKey(
        UserDbController.normalizePermission(mutation),
      );
      if (updatedKeys.has(key) || removedKeys.has(key)) {
        continue;
      }

      counts.added += 1;
    }

    return counts;
  }

  private static getUserHistoryChangeCount(
    requestData: any,
    oldData: any,
    requestType: string | null | undefined,
  ): HistoryChangeCount {
    const stored = UserDbController.normalizeChangeCount(
      requestData?.changeCount ?? oldData?.changeCount,
    );

    const normalizedType = String(requestType || '').toUpperCase();
    const diffCount =
      UserDbController.getUserHistoryChangeCountFromPermissionDiff(
        requestData,
        oldData,
      );
    if (diffCount) {
      return diffCount;
    }

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

      const normalizedMutation = UserDbController.normalizePermission(mutation);
      const replacedPrimary = oldPermissions.find(
        (permission) => permission.accessType === 'PRIMARY',
      );
      if (
        normalizedMutation.accessType === 'PRIMARY' &&
        replacedPrimary &&
        !UserDbController.permissionsEqual(replacedPrimary, normalizedMutation)
      ) {
        counts.modify += 1;
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

      if (
        oldPermissionKeys.has(UserDbController.permissionMutationKey(mutation))
      ) {
        counts.modify += 1;
      } else {
        counts.added += 1;
      }
    }

    if (
      counts.added === 0 &&
      counts.modify === 0 &&
      counts.remove === 0 &&
      (stored.added || stored.modify || stored.remove)
    ) {
      return stored;
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

  private static extractPendingUserRequestNodePaths(data: any): string[] {
    const source = UserDbController.normalizeUserSnapshotSource(data);
    const permissions = Array.isArray(source?.permissions)
      ? source.permissions
      : Array.isArray(source?.data?.permissions)
        ? source.data.permissions
        : [];

    return Array.from(
      new Set(
        permissions
          .map((permission: any) =>
            typeof permission?.nodePath === 'string'
              ? permission.nodePath.trim()
              : '',
          )
          .filter(Boolean),
      ),
    );
  }

  private static extractUserNotificationNodePaths(data: any): string[] {
    const source = UserDbController.normalizeUserSnapshotSource(data);
    const currentData = source?.currentData || data?.currentData || {};
    const newData = source?.newData || data?.newData || {};
    const oldData = source?.oldData || data?.oldData || {};
    const candidateNodePaths = [
      ...UserDbController.extractPendingUserRequestNodePaths(data),
      data?.targetNodePath,
      data?.nodePath,
      data?.orgStructure?.nodePath,
      data?.basicDetails?.nodePath,
      source?.targetNodePath,
      source?.nodePath,
      source?.orgStructure?.nodePath,
      source?.basicDetails?.nodePath,
      currentData?.nodePath,
      currentData?.orgStructure?.nodePath,
      currentData?.basicDetails?.nodePath,
      newData?.nodePath,
      newData?.orgStructure?.nodePath,
      newData?.basicDetails?.nodePath,
      oldData?.nodePath,
      oldData?.orgStructure?.nodePath,
      oldData?.basicDetails?.nodePath,
    ];

    return Array.from(
      new Set(
        candidateNodePaths
          .map((nodePath) =>
            typeof nodePath === 'string' ? nodePath.trim() : '',
          )
          .filter(Boolean),
      ),
    );
  }

  private static async getNodeAccessNotificationRecipientIds(
    companyId: string,
    nodePaths: string[],
  ) {
    const normalizedNodePaths = Array.from(
      new Set(
        nodePaths
          .map((nodePath) =>
            typeof nodePath === 'string' ? nodePath.trim() : '',
          )
          .filter(Boolean),
      ),
    );

    if (normalizedNodePaths.length === 0) {
      return [];
    }

    const companyMappedUsers = await prisma.userMapping.findMany({
      where: {
        companyId,
        status: 'ACTIVE',
      },
      select: {
        userId: true,
      },
    });
    const mappedUserIds = Array.from(
      new Set(
        companyMappedUsers
          .map((mapping) => String(mapping.userId || '').trim())
          .filter(Boolean),
      ),
    );

    if (mappedUserIds.length === 0) {
      return [];
    }

    const userAccesses = await prisma.userAccess.findMany({
      where: {
        companyId,
        userId: {
          in: mappedUserIds,
        },
      },
      include: {
        role: {
          select: {
            isActive: true,
          },
        },
        orgStructure: {
          select: {
            nodePath: true,
            status: true,
          },
        },
      },
    });

    const recipientIds = userAccesses
      .filter((access) => {
        if (access.role?.isActive === false) {
          return false;
        }

        if (!access.isGlobalAccess && access.orgStructure?.status !== 'ACTIVE') {
          return false;
        }

        return normalizedNodePaths.some((nodePath) =>
          UserDbController.doesAccessCoverNode(access, nodePath),
        );
      })
      .map((access) => access.userId);

    return Array.from(new Set(recipientIds));
  }

  private static normalizeEmail(value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  private static getPendingRequestTargetEmail(request: any): string {
    return UserDbController.normalizeEmail(
      UserDbController.extractUserTargetEmail(request?.data),
    );
  }

  private static async getEffectivePendingUserRequestsByEmail(
    companyId: string,
    emails: Array<string | null | undefined>,
  ) {
    const normalizedEmails = Array.from(
      new Set(
        emails
          .map((email) => UserDbController.normalizeEmail(email))
          .filter(Boolean),
      ),
    );
    const pendingByEmail = new Map<string, any>();
    if (normalizedEmails.length === 0) return pendingByEmail;

    const allPendingCandidates = await prisma.userOnboarding.findMany({
      where: {
        companyId,
        status: 'PENDING',
      },
      select: { id: true, data: true, type: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const requestedEmailSet = new Set(normalizedEmails);
    const pendingCandidates = allPendingCandidates.filter((request: any) =>
      requestedEmailSet.has(
        UserDbController.getPendingRequestTargetEmail(request),
      ),
    );
    const effectivePendingIds =
      await UserDbController.filterEffectivelyPendingRequestIds(
        'user_onboarding',
        pendingCandidates.map((request: any) => request.id),
      );

    pendingCandidates.forEach((request: any) => {
      if (!effectivePendingIds.has(request.id)) return;

      const email = UserDbController.getPendingRequestTargetEmail(request);
      if (email && !pendingByEmail.has(email)) {
        pendingByEmail.set(email, request);
      }
    });

    return pendingByEmail;
  }

  private static isPendingUserRequestVisible(params: {
    onboarding: any;
    isGlobal: boolean;
    visibleNodePaths: string[];
    viewerUserId?: string | null;
    visibleRequestIds?: Set<string>;
  }) {
    const {
      onboarding,
      isGlobal,
      visibleNodePaths,
      viewerUserId = null,
      visibleRequestIds = new Set<string>(),
    } = params;

    if (!onboarding?.id) return false;
    if (isGlobal) return true;
    if (visibleRequestIds.has(onboarding.id)) return true;
    if (viewerUserId && onboarding.initiatorId === viewerUserId) return true;
    if (
      viewerUserId &&
      Array.isArray(onboarding.eligibleApprovers) &&
      onboarding.eligibleApprovers.includes(viewerUserId)
    ) {
      return true;
    }
    return false;
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

  private static buildPendingUserSnapshotAroundRequest(
    requests: any[],
    selectedRequest: any,
    baseSnapshot: UserDataSnapshot | null,
  ) {
    if (!selectedRequest?.id) {
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

    let currentSnapshot = baseSnapshot ? cloneJson(baseSnapshot) : null;
    const sortedRequests = [...requests].sort((left, right) => {
      const leftTime = new Date(left.createdAt).getTime();
      const rightTime = new Date(right.createdAt).getTime();
      if (leftTime !== rightTime) return leftTime - rightTime;
      return String(left.id || '').localeCompare(String(right.id || ''));
    });

    for (const request of sortedRequests) {
      const requestTime = new Date(request.createdAt).getTime();
      const selectedTime = new Date(selectedRequest.createdAt).getTime();
      if (
        requestTime > selectedTime ||
        (requestTime === selectedTime &&
          String(request.id || '').localeCompare(
            String(selectedRequest.id || ''),
          ) > 0)
      ) {
        break;
      }

      const requestTargetEmail =
        UserDbController.extractUserTargetEmail(request.data) || null;
      const currentEmail =
        currentSnapshot?.basicDetails.email.toLowerCase() || null;
      const matchesCurrentUser =
        request.id === selectedRequest.id ||
        !selectedTargetEmail ||
        requestTargetEmail === selectedTargetEmail ||
        requestTargetEmail === currentEmail;

      if (!matchesCurrentUser) continue;

      const nextSnapshot =
        request.type === 'INITIATE'
          ? UserDbController.extractUserSnapshot(request.data)
          : currentSnapshot
            ? UserDbController.applyUserRequestSnapshot(
                currentSnapshot,
                request,
              )
            : null;

      if (request.id === selectedRequest.id) {
        return {
          oldData: currentSnapshot ? cloneJson(currentSnapshot) : null,
          newData: nextSnapshot,
        };
      }

      if (nextSnapshot) {
        currentSnapshot = nextSnapshot;
      }
    }

    return {
      oldData: baseSnapshot ? cloneJson(baseSnapshot) : null,
      newData: null,
    };
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
        .filter(
          (permission) => !UserDbController.isPermissionRemoval(permission),
        )
        .map((permission) =>
          [permission?.roleName || '', permission?.nodePath || ''].join('|'),
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

  private static compactFilterValue(value: unknown) {
    const normalized = UserDbController.normalizeFilterText(value);
    if (!normalized) return null;

    const compact = normalized.toLowerCase().replace(/[^a-z0-9]+/g, '');
    return compact || null;
  }

  private static normalizeAppliedFilterValues(values: unknown) {
    const normalizeItem = (value: unknown) => {
      if (value && typeof value === 'object') {
        const source = value as Record<string, unknown>;
        return (
          UserDbController.compactFilterValue(source.value) ||
          UserDbController.compactFilterValue(source.label) ||
          UserDbController.compactFilterValue(source.name)
        );
      }

      return UserDbController.compactFilterValue(value);
    };

    if (typeof values === 'string') {
      const normalized = normalizeItem(values);
      return normalized ? [normalized] : [];
    }

    if (!Array.isArray(values)) {
      const normalized = normalizeItem(values);
      return normalized ? [normalized] : [];
    }

    return Array.from(
      new Set(
        values
          .map((value) => normalizeItem(value))
          .filter((value): value is string => Boolean(value)),
      ),
    );
  }

  private static normalizeAppliedNodeValues(values: unknown) {
    const normalizeItem = (value: unknown) => {
      if (value && typeof value === 'object') {
        const source = value as Record<string, unknown>;
        return [
          source.value,
          source.path,
          source.nodeName,
          source.nodePath,
          source.label,
        ]
          .map((item) => UserDbController.compactFilterValue(item))
          .filter((item): item is string => Boolean(item));
      }

      const normalized = UserDbController.compactFilterValue(value);
      return normalized ? [normalized] : [];
    };

    const items =
      Array.isArray(values) || typeof values === 'string'
        ? values
        : values === undefined || values === null
          ? []
          : [values];

    return Array.from(
      new Set(
        (Array.isArray(items) ? items : [items]).flatMap((value) =>
          normalizeItem(value),
        ),
      ),
    );
  }

  private static normalizeAppliedNumberValues(
    values: unknown,
    limits: { min: number; max: number },
  ) {
    const normalizeItem = (value: unknown) => {
      if (value && typeof value === 'object') {
        const objectValue = (value as Record<string, unknown>).value;
        if (objectValue !== undefined) {
          return Number(objectValue);
        }
      }

      return Number(value);
    };

    const items =
      typeof values === 'string'
        ? values.includes(',')
          ? values.split(',')
          : [values]
        : Array.isArray(values)
          ? values
          : values === undefined || values === null || values === ''
            ? []
            : [values];

    return Array.from(
      new Set(
        items
          .map((value) => normalizeItem(value))
          .filter(
            (value) =>
              Number.isInteger(value) &&
              value >= limits.min &&
              value <= limits.max,
          ),
      ),
    );
  }

  private static extractWorkflowCheckerCountFromAlias(alias: unknown) {
    const normalized = UserDbController.normalizeFilterText(alias);
    if (!normalized) return null;

    const match = normalized.match(/_(\d+)C(?:_|$)/i);
    if (!match) return null;

    const count = Number(match[1]);
    return Number.isInteger(count) && count >= 0 ? count : null;
  }

  private static extractWorkflowLevelCountFromAlias(alias: unknown) {
    const normalized = UserDbController.normalizeFilterText(alias);
    if (!normalized) return null;

    const match = normalized.match(/_(\d+)$/);
    if (!match) return null;

    const count = Number(match[1]);
    return Number.isInteger(count) && count > 0 ? count : null;
  }

  private static resolveWorkflowCheckerCount(
    alias: unknown,
    levels: Array<{ approver1?: unknown; approver2?: unknown }>,
  ) {
    const levelDerivedCount = levels.reduce((count, level) => {
      const approvers = [level.approver1, level.approver2].filter(Boolean);
      return count + approvers.length;
    }, 0);

    if (levelDerivedCount > 0) {
      return levelDerivedCount;
    }

    const aliasCount = UserDbController.extractWorkflowCheckerCountFromAlias(
      alias,
    );
    return aliasCount ?? 0;
  }

  private static resolveWorkflowLevelCount(
    alias: unknown,
    levelNumbers: number[],
  ) {
    const uniqueLevelCount = new Set(levelNumbers).size;
    if (uniqueLevelCount > 0) return uniqueLevelCount;

    const aliasCount = UserDbController.extractWorkflowLevelCountFromAlias(
      alias,
    );
    return aliasCount ?? 0;
  }

  private static normalizeWorkflowCompanyFilters(
    applied: unknown,
  ): CompanyWorkflowFilterApplied | null {
    const source =
      applied && typeof applied === 'object'
        ? (applied as Record<string, unknown>)
        : null;
    if (!source) return null;

    const nodeName =
      source.nodeName &&
      typeof source.nodeName === 'object' &&
      !Array.isArray(source.nodeName)
        ? (source.nodeName as Record<string, unknown>)
        : null;
    const nodeValues =
      typeof source.nodeName === 'string' ? [source.nodeName] : nodeName?.values;
    const rawLevels = Array.isArray(source.levels) ? source.levels : [];
    const normalizedLevels = rawLevels
      .flatMap((level) => {
        if (typeof level === 'string') {
          return [level];
        }

        if (
          level &&
          typeof level === 'object' &&
          Number.isInteger(Number((level as any).count))
        ) {
          return [`LEVEL${Number((level as any).count)}`];
        }

        return [];
      })
      .map((level) => UserDbController.compactFilterValue(level))
      .filter((level): level is string => Boolean(level));

    const normalized: CompanyWorkflowFilterApplied = {
      nodeValues: UserDbController.normalizeAppliedNodeValues(
        nodeValues ?? source.nodeName,
      ),
      nodeType: UserDbController.normalizeAppliedFilterValues(source.nodeType),
      module: UserDbController.normalizeAppliedFilterValues(source.module),
      subCategory: UserDbController.normalizeAppliedFilterValues(
        source.subCategory ?? source.subModule,
      ),
      checkerCounts: UserDbController.normalizeAppliedNumberValues(
        source.checker ?? source.checkerCount ?? source.checkers,
        { min: 1, max: 10 },
      ),
      workflowLevels: UserDbController.normalizeAppliedNumberValues(
        source.workflowLevel ?? source.workflowLevels,
        { min: 1, max: 10 },
      ),
      levels: Array.from(new Set(normalizedLevels)),
    };

    const hasFilters =
      normalized.nodeValues.length > 0 ||
      normalized.nodeType.length > 0 ||
      normalized.module.length > 0 ||
      normalized.subCategory.length > 0 ||
      normalized.checkerCounts.length > 0 ||
      normalized.workflowLevels.length > 0 ||
      normalized.levels.length > 0;

    return hasFilters ? normalized : null;
  }

  private static parseUserFilterDateRange(applied: any) {
    const onboardingDate =
      applied && typeof applied === 'object' ? applied.onboardingDate : null;
    if (!onboardingDate || typeof onboardingDate !== 'object') {
      return null;
    }

    const parseBoundary = (
      value: unknown,
      boundary: 'start' | 'end',
    ): Date | null => {
      const normalized = UserDbController.normalizeFilterText(value);
      if (!normalized) return null;

      const suffix = boundary === 'start' ? 'T00:00:00.000Z' : 'T23:59:59.999Z';
      const parsed = new Date(`${normalized}${suffix}`);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    };

    const startOfDay = (date: Date) =>
      new Date(
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
      );
    const endOfDay = (date: Date) =>
      new Date(
        Date.UTC(
          date.getUTCFullYear(),
          date.getUTCMonth(),
          date.getUTCDate(),
          23,
          59,
          59,
          999,
        ),
      );

    const explicitFrom = parseBoundary(onboardingDate.fromDate, 'start');
    const explicitTo = parseBoundary(onboardingDate.toDate, 'end');
    const range = UserDbController.normalizeFilterText(
      onboardingDate.dateRange,
    )?.toUpperCase();

    if (range === 'CUSTOM') {
      if (!explicitFrom || !explicitTo) {
        throw new AppError(
          'fromDate and toDate are required when dateRange is CUSTOM',
          400,
        );
      }

      if (explicitFrom > explicitTo) {
        throw new AppError(
          'fromDate must be earlier than or equal to toDate',
          400,
        );
      }

      return {
        from: explicitFrom,
        to: explicitTo,
      };
    }

    if (explicitFrom || explicitTo) {
      return {
        from: explicitFrom,
        to: explicitTo,
      };
    }

    if (!range) return null;

    const now = new Date();
    const todayStart = startOfDay(now);
    const todayEnd = endOfDay(now);
    const from = new Date(todayStart);

    if (range === '7DAYS') {
      from.setUTCDate(from.getUTCDate() - 6);
    } else if (range === '15DAYS') {
      from.setUTCDate(from.getUTCDate() - 14);
    } else if (range === '1MONTH') {
      from.setUTCMonth(from.getUTCMonth() - 1);
    } else if (range === '1YEAR') {
      from.setUTCFullYear(from.getUTCFullYear() - 1);
    } else {
      return null;
    }

    return {
      from,
      to: todayEnd,
    };
  }

  private static normalizeUserListAppliedFilters(
    applied: unknown,
  ): NormalizedUserListAppliedFilters | null {
    const source =
      applied && typeof applied === 'object'
        ? (applied as Record<string, unknown>)
        : null;
    if (!source) return null;

    const nodeName =
      source.nodeName && typeof source.nodeName === 'object'
        ? (source.nodeName as Record<string, unknown>)
        : null;

    // Parse nodeAccess: supports both legacy string format and new per-node object format
    let nodeAccess: Record<string, string[]> = {};
    const rawNodeAccess = nodeName?.nodeAccess;
    if (typeof rawNodeAccess === 'string') {
      // Legacy format: single "primary" / "secondary" string → apply to ALL node values
      const normalizedAccessStr = rawNodeAccess.trim().toUpperCase();
      if (
        normalizedAccessStr === 'PRIMARY' ||
        normalizedAccessStr === 'SECONDARY'
      ) {
        const nodeValues = UserDbController.normalizeAppliedFilterValues(
          nodeName?.values,
        );
        for (const nodeVal of nodeValues) {
          nodeAccess[nodeVal] = [normalizedAccessStr];
        }
      }
    } else if (
      rawNodeAccess &&
      typeof rawNodeAccess === 'object' &&
      !Array.isArray(rawNodeAccess)
    ) {
      // New format: per-node access map, e.g. { "NEXORA": ["Primary", "Secondary"], "Surat": ["Primary"] }
      const accessMap = rawNodeAccess as Record<string, unknown>;
      for (const [key, value] of Object.entries(accessMap)) {
        if (Array.isArray(value)) {
          const normalizedValues = value
            .map((v) => (typeof v === 'string' ? v.trim().toUpperCase() : ''))
            .filter((v) => v === 'PRIMARY' || v === 'SECONDARY');
          if (normalizedValues.length > 0) {
            // Compact the key the same way nodeValues are compacted so that
            // the lookup filters.nodeAccess[filterNodeValue] works correctly.
            const compactedKey = UserDbController.compactFilterValue(key);
            if (compactedKey) {
              // Merge with any existing entry for the same compacted key
              const existing = nodeAccess[compactedKey] || [];
              nodeAccess[compactedKey] = Array.from(
                new Set([...existing, ...normalizedValues]),
              );
            }
          }
        }
      }
    }

    const normalized: NormalizedUserListAppliedFilters = {
      designation: UserDbController.normalizeAppliedFilterValues(
        source.designation,
      ),
      nodeValues: UserDbController.normalizeAppliedFilterValues(
        nodeName?.values,
      ),
      nodeAccess,
      nodeType: UserDbController.normalizeAppliedFilterValues(source.nodeType),
      category: UserDbController.normalizeAppliedFilterValues(source.category),
      subCategory: UserDbController.normalizeAppliedFilterValues(
        source.subCategory,
      ),
      reportingManager: UserDbController.normalizeAppliedFilterValues(
        source.reportingManager,
      ),
      status: UserDbController.normalizeAppliedFilterValues(source.status),
      role: UserDbController.normalizeAppliedFilterValues(source.role),
      currentStatus:
        UserDbController.normalizeFilterText(
          source.currentStatus,
        )?.toLowerCase() === 'initiate'
          ? 'INITIATE'
          : UserDbController.normalizeFilterText(
                source.currentStatus,
              )?.toLowerCase() === 'modify'
            ? 'MODIFY'
            : null,
      hasPending:
        UserDbController.normalizeFilterText(
          source.hasPending,
        )?.toLowerCase() === 'yes'
          ? true
          : UserDbController.normalizeFilterText(
                source.hasPending,
              )?.toLowerCase() === 'no'
            ? false
            : null,
      onboardingDate: UserDbController.parseUserFilterDateRange(source),
    };

    const hasNodeAccess = Object.keys(normalized.nodeAccess).length > 0;

    const hasFilters =
      normalized.designation.length > 0 ||
      normalized.nodeValues.length > 0 ||
      hasNodeAccess ||
      normalized.nodeType.length > 0 ||
      normalized.category.length > 0 ||
      normalized.subCategory.length > 0 ||
      normalized.reportingManager.length > 0 ||
      normalized.status.length > 0 ||
      normalized.role.length > 0 ||
      normalized.currentStatus !== null ||
      normalized.hasPending !== null ||
      normalized.onboardingDate !== null;

    return hasFilters ? normalized : null;
  }

  private static matchesNormalizedFilterValue(
    value: unknown,
    acceptedValues: string[],
  ) {
    if (acceptedValues.length === 0) return true;

    const normalized = UserDbController.compactFilterValue(value);
    return Boolean(normalized && acceptedValues.includes(normalized));
  }

  private static matchesRoleFilter(access: any, acceptedValues: string[]) {
    if (acceptedValues.length === 0) return true;

    const accessRoleBucket = UserDbController.resolveAccessRoleBucket(access);
    const permissionLevel = String(
      access?.permissionLevel ?? access?.role?.permissionLevel ?? '',
    ).toUpperCase();
    const canView = Boolean(access?.canView ?? access?.role?.view);
    const canModify = Boolean(access?.canModify ?? access?.role?.modify);
    const canApprove = Boolean(access?.canApprove ?? access?.role?.approve);
    const canInitiate = Boolean(access?.canInitiate ?? access?.role?.initiate);
    const normalizedRoleName = UserDbController.compactFilterValue(
      access?.roleName ?? access?.role?.roleName,
    );

    return acceptedValues.some((accepted) => {
      if (accepted === 'maker') {
        return accessRoleBucket === 'maker';
      }
      if (accepted === 'checker') {
        return accessRoleBucket === 'checker';
      }
      if (accepted === 'user' || accepted === 'viewer') {
        return accessRoleBucket === 'user';
      }

      if (!normalizedRoleName) return false;

      return (
        normalizedRoleName === accepted || normalizedRoleName.includes(accepted)
      );
    });
  }

  private static resolveAccessRoleBucket(access: any) {
    const permissionLevel = String(
      access?.permissionLevel ?? access?.role?.permissionLevel ?? '',
    ).toUpperCase();
    const canView = Boolean(access?.canView ?? access?.role?.view);
    const canModify = Boolean(access?.canModify ?? access?.role?.modify);
    const canApprove = Boolean(access?.canApprove ?? access?.role?.approve);
    const canInitiate = Boolean(access?.canInitiate ?? access?.role?.initiate);

    if (
      permissionLevel === 'MANAGER' ||
      (canApprove && !canModify && !canInitiate)
    ) {
      return 'checker' as const;
    }

    if (
      permissionLevel === 'VIEWER' ||
      (canView && !canModify && !canApprove && !canInitiate)
    ) {
      return 'user' as const;
    }

    if (
      permissionLevel === 'USER' ||
      ((canInitiate || canModify) && !canApprove)
    ) {
      return 'maker' as const;
    }

    return null;
  }

  private static matchesCreatedAtRange(
    value: unknown,
    range: NormalizedUserListAppliedFilters['onboardingDate'],
  ) {
    if (!range) return true;

    const date = value instanceof Date ? value : new Date(String(value || ''));
    if (Number.isNaN(date.getTime())) return false;
    if (range.from && date < range.from) return false;
    if (range.to && date > range.to) return false;
    return true;
  }

  private static normalizeCurrentPendingStatus(requestType: unknown) {
    const normalizedType = UserDbController.normalizeFilterText(requestType);
    if (!normalizedType) return null;

    return normalizedType.toUpperCase() === 'INITIATE' ? 'INITIATE' : 'MODIFY';
  }

  private static resolvePendingApprovalSubModules(
    filters: NormalizedUserListAppliedFilters | null,
  ) {
    const selected = new Set(filters?.subCategory || []);
    const hasExplicitSelection = selected.size > 0;
    const modules = new Set<'USER_ACC' | 'ORG_STR' | 'WORK_FLOW'>();

    if (!hasExplicitSelection || selected.has('useracc')) {
      modules.add('USER_ACC');
    }
    if (!hasExplicitSelection || selected.has('orgstr')) {
      modules.add('ORG_STR');
    }
    if (!hasExplicitSelection || selected.has('workflow')) {
      modules.add('WORK_FLOW');
    }

    return Array.from(modules);
  }

  private static async getPendingApprovalEligibleUserCounts(
    companyId: string,
    filters: NormalizedUserListAppliedFilters | null,
  ): Promise<Map<string, PendingApprovalEligibleUserSummary>> {
    const pendingModules =
      UserDbController.resolvePendingApprovalSubModules(filters);
    if (pendingModules.length === 0) {
      return new Map<string, PendingApprovalEligibleUserSummary>();
    }

    const includeUserAcc = pendingModules.includes('USER_ACC');
    const includeOrgStr = pendingModules.includes('ORG_STR');
    const includeWorkFlow = pendingModules.includes('WORK_FLOW');

    const [userRequests, orgRequests, workflowRequests] = await Promise.all([
      includeUserAcc
        ? prisma.userOnboarding.findMany({
            where: {
              companyId,
              status: 'PENDING',
            },
            select: { id: true, initiatorId: true, eligibleApprovers: true },
          })
        : Promise.resolve([]),
      includeOrgStr
        ? prisma.orgStructureReq.findMany({
            where: {
              companyId,
              status: 'PENDING',
            },
            select: { id: true, initiatorId: true, eligibleApprovers: true },
          })
        : Promise.resolve([]),
      includeWorkFlow
        ? prisma.workflowReq.findMany({
            where: {
              companyId,
              status: 'PENDING',
            },
            select: {
              id: true,
              initiatorId: true,
              eligibleApprovers: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const eligibleUserSummaries = new Map<
      string,
      PendingApprovalEligibleUserSummary
    >();

    const addSummary = (
      userId: string,
      subCategory: 'USER_ACC' | 'ORG_STR' | 'WORK_FLOW',
    ) => {
      const current = eligibleUserSummaries.get(userId) || {
        count: 0,
        subCategories: new Set<'USER_ACC' | 'ORG_STR' | 'WORK_FLOW'>(),
      };
      current.count += 1;
      current.subCategories.add(subCategory);
      eligibleUserSummaries.set(userId, current);
    };

    const addRequestTableApprovers = async (
      reqTable: 'user_onboarding' | 'org_structure_req' | 'workflow_req',
      requests: any[],
      resolveSubCategory: (
        request: any,
      ) => 'USER_ACC' | 'ORG_STR' | 'WORK_FLOW' | null,
    ) => {
      const requestIds = requests.map((request) => request.id).filter(Boolean);
      if (requestIds.length === 0) return;

      const effectiveRequestIds =
        await UserDbController.filterEffectivelyPendingRequestIds(
          reqTable,
          requestIds,
        );
      const requestMeta = new Map<
        string,
        {
          subCategory: 'USER_ACC' | 'ORG_STR' | 'WORK_FLOW';
          initiatorId: string | null;
          legacyEligibleApprovers: string[];
        }
      >();

      requests.forEach((request) => {
        if (!effectiveRequestIds.has(request.id)) return;

        const subCategory = resolveSubCategory(request);
        if (!subCategory) return;

        requestMeta.set(request.id, {
          subCategory,
          initiatorId:
            typeof request.initiatorId === 'string'
              ? request.initiatorId
              : null,
          legacyEligibleApprovers: Array.isArray(request.eligibleApprovers)
            ? request.eligibleApprovers.filter(
                (approverId: unknown): approverId is string =>
                  typeof approverId === 'string' && Boolean(approverId.trim()),
              )
            : [],
        });
      });

      const effectiveIds = Array.from(requestMeta.keys());
      if (effectiveIds.length === 0) return;

      const [approverRows, approvedHistoryRows] = await Promise.all([
        prisma.workflowApprover.findMany({
          where: {
            reqTable,
            reqId: { in: effectiveIds },
            status: 'PENDING',
          },
          select: { reqId: true, approversList: true },
        }),
        reqTable === 'workflow_req'
          ? prisma.workflowReqHistory.findMany({
              where: { workflowReqId: { in: effectiveIds }, event: 'APPROVED' },
              select: { workflowReqId: true, eventUserId: true },
            })
          : reqTable === 'org_structure_req'
            ? prisma.orgHistory.findMany({
                where: { orgReqId: { in: effectiveIds }, event: 'APPROVED' },
                select: { orgReqId: true, eventUserId: true },
              })
            : prisma.userHistory.findMany({
                where: { reqId: { in: effectiveIds }, event: 'APPROVED' },
                select: { reqId: true, eventUserId: true },
              }),
      ]);

      const approvedByRequest = new Map<string, Set<string>>();
      approvedHistoryRows.forEach((row: any) => {
        const reqId = row.workflowReqId || row.orgReqId || row.reqId;
        const eventUserId =
          typeof row.eventUserId === 'string' ? row.eventUserId : null;
        if (!reqId || !eventUserId) return;

        const approved = approvedByRequest.get(reqId) || new Set<string>();
        approved.add(eventUserId);
        approvedByRequest.set(reqId, approved);
      });

      const approversByRequest = new Map<string, Set<string>>();
      approverRows.forEach((row: any) => {
        const requestApprovers =
          approversByRequest.get(row.reqId) || new Set<string>();
        if (Array.isArray(row.approversList)) {
          row.approversList.forEach((approverId: unknown) => {
            if (typeof approverId === 'string' && approverId.trim()) {
              requestApprovers.add(approverId.trim());
            }
          });
        }
        approversByRequest.set(row.reqId, requestApprovers);
      });

      requestMeta.forEach((meta, requestId) => {
        const pendingApprovers = approversByRequest.get(requestId);
        const rawApprovers =
          pendingApprovers && pendingApprovers.size > 0
            ? pendingApprovers
            : new Set(meta.legacyEligibleApprovers);
        const excluded = approvedByRequest.get(requestId) || new Set<string>();
        if (meta.initiatorId) excluded.add(meta.initiatorId);

        rawApprovers.forEach((approverId) => {
          if (!excluded.has(approverId)) {
            addSummary(approverId, meta.subCategory);
          }
        });
      });
    };

    await Promise.all([
      addRequestTableApprovers(
        'user_onboarding',
        userRequests,
        () => 'USER_ACC',
      ),
      addRequestTableApprovers(
        'org_structure_req',
        orgRequests,
        () => 'ORG_STR',
      ),
      addRequestTableApprovers(
        'workflow_req',
        workflowRequests,
        () => 'WORK_FLOW',
      ),
    ]);

    return eligibleUserSummaries;
  }

  private static matchesAppliedUserFilters(
    user: any,
    filters: NormalizedUserListAppliedFilters | null,
    options: {
      defaultStatus: string;
      isPendingRecord?: boolean;
      pendingRequestType?: unknown;
      hasPendingOverride?: boolean | null;
      pendingApprovalSubCategories?: string[];
    },
  ) {
    if (!filters) return true;

    const basicDetails = user?.basicDetails || {};
    const primary = Array.isArray(user?.primary) ? user.primary : [];
    const secondary = Array.isArray(user?.secondary) ? user.secondary : [];
    const allAccesses = [...primary, ...secondary];
    const hasNodeAccessMap = Object.keys(filters.nodeAccess).length > 0;
    const isPendingRecord =
      options.isPendingRecord === true || user?.isPending === true;
    const hasPending =
      options.hasPendingOverride !== undefined &&
      options.hasPendingOverride !== null
        ? options.hasPendingOverride
        : false;
    const pendingApprovalSubCategories = new Set(
      (options.pendingApprovalSubCategories || [])
        .map((subCategory) => UserDbController.compactFilterValue(subCategory))
        .filter((subCategory): subCategory is string => Boolean(subCategory)),
    );
    const currentPendingStatus = isPendingRecord
      ? UserDbController.normalizeCurrentPendingStatus(
          options.pendingRequestType,
        )
      : null;
    const statusCandidates = [
      options.defaultStatus,
      isPendingRecord ? null : basicDetails.status,
      isPendingRecord ? 'PENDING' : null,
    ]
      .map((value) => UserDbController.compactFilterValue(value))
      .filter((value): value is string => Boolean(value));

    if (
      filters.designation.length > 0 &&
      !UserDbController.matchesNormalizedFilterValue(
        basicDetails.designation,
        filters.designation,
      )
    ) {
      return false;
    }

    // --- Combined access-level filter check (intersection semantics) ---
    // When multiple access-level filters (nodeName, nodeType, category,
    // subCategory, role) are active, at least one access record must
    // satisfy ALL of them simultaneously on the same record.
    const hasNodeNameFilter = filters.nodeValues.length > 0 || hasNodeAccessMap;
    const hasNodeTypeFilter = filters.nodeType.length > 0;
    const hasCategoryFilter = filters.category.length > 0;
    const hasSubCategoryFilter = filters.subCategory.length > 0;
    const hasRoleFilter = filters.role.length > 0;
    const hasAnyAccessFilter =
      hasNodeNameFilter ||
      hasNodeTypeFilter ||
      hasCategoryFilter ||
      hasSubCategoryFilter ||
      hasRoleFilter;

    if (hasAnyAccessFilter) {
      // subCategory can also be satisfied by pending approval subcategories
      // (a user-level flag, not per-access)
      const matchesPendingApprovalSubCategory =
        hasPending &&
        hasSubCategoryFilter &&
        filters.subCategory.some((subCategory) =>
          pendingApprovalSubCategories.has(subCategory),
        );

      // If subCategory is the only active access filter and it is already
      // satisfied by pending approvals, skip the per-access intersection.
      const skipAccessCheck =
        matchesPendingApprovalSubCategory &&
        !hasNodeNameFilter &&
        !hasNodeTypeFilter &&
        !hasCategoryFilter &&
        !hasRoleFilter;

      if (!skipAccessCheck) {
        const primarySet = new Set(primary);

        const hasMatchingAccess = allAccesses.some((access: any) => {
          const isPrimary = primarySet.has(access);

          // ── nodeName / nodeAccess filter ──
          if (hasNodeNameFilter) {
            if (filters.nodeValues.length > 0) {
              const nodeMatch = filters.nodeValues.some((filterNodeValue) => {
                const matchesNode =
                  UserDbController.matchesNormalizedFilterValue(
                    access?.nodeName,
                    [filterNodeValue],
                  ) ||
                  UserDbController.matchesNormalizedFilterValue(
                    access?.nodePath,
                    [filterNodeValue],
                  );
                if (!matchesNode) return false;

                const requiredAccessTypes = filters.nodeAccess[filterNodeValue];
                if (!requiredAccessTypes || requiredAccessTypes.length === 0)
                  return true;

                return requiredAccessTypes.some((accessType) => {
                  if (accessType === 'PRIMARY') return isPrimary;
                  if (accessType === 'SECONDARY') return !isPrimary;
                  return true;
                });
              });
              if (!nodeMatch) return false;
            } else {
              // nodeValues empty but nodeAccess has entries
              const accessTypeMatch = Object.entries(filters.nodeAccess).some(
                ([nodeKey, accessTypes]) => {
                  const matchesNode =
                    UserDbController.matchesNormalizedFilterValue(
                      access?.nodeName,
                      [nodeKey],
                    ) ||
                    UserDbController.matchesNormalizedFilterValue(
                      access?.nodePath,
                      [nodeKey],
                    );
                  if (!matchesNode) return false;
                  return accessTypes.some((accessType) => {
                    if (accessType === 'PRIMARY') return isPrimary;
                    if (accessType === 'SECONDARY') return !isPrimary;
                    return true;
                  });
                },
              );
              if (!accessTypeMatch) return false;
            }
          }

          // ── nodeType filter ──
          if (
            hasNodeTypeFilter &&
            !UserDbController.matchesNormalizedFilterValue(
              access?.nodeType,
              filters.nodeType,
            )
          ) {
            return false;
          }

          // ── category filter ──
          if (
            hasCategoryFilter &&
            !UserDbController.matchesNormalizedFilterValue(
              access?.roleCategory,
              filters.category,
            )
          ) {
            return false;
          }

          // ── subCategory filter (skip if satisfied by pending approvals) ──
          if (
            hasSubCategoryFilter &&
            !matchesPendingApprovalSubCategory &&
            !UserDbController.matchesNormalizedFilterValue(
              access?.roleSubCategory,
              filters.subCategory,
            )
          ) {
            return false;
          }

          // ── role filter ──
          if (
            hasRoleFilter &&
            !UserDbController.matchesRoleFilter(access, filters.role)
          ) {
            return false;
          }

          return true;
        });

        if (!hasMatchingAccess) {
          return false;
        }
      }
    }

    if (
      filters.reportingManager.length > 0 &&
      !(
        UserDbController.matchesNormalizedFilterValue(
          basicDetails.reportingManagerName,
          filters.reportingManager,
        ) ||
        UserDbController.matchesNormalizedFilterValue(
          basicDetails.reportingManagerEmail,
          filters.reportingManager,
        )
      )
    ) {
      return false;
    }

    if (
      filters.status.length > 0 &&
      !statusCandidates.some((status) => filters.status.includes(status))
    ) {
      return false;
    }

    if (
      filters.currentStatus !== null &&
      currentPendingStatus !== filters.currentStatus
    ) {
      return false;
    }

    if (filters.hasPending !== null && hasPending !== filters.hasPending) {
      return false;
    }

    if (
      !UserDbController.matchesCreatedAtRange(
        basicDetails.createdAt,
        filters.onboardingDate,
      )
    ) {
      return false;
    }

    return true;
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

  private static humanizeFilterLabel(value: unknown) {
    const normalized = UserDbController.normalizeFilterText(value);
    if (!normalized) return null;

    return normalized
      .toLowerCase()
      .split(/[_\s]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
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

    return prisma.workflow
      .findFirst({
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
      })
      .then((workflow) =>
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
    const effectiveIds =
      await UserDbController.filterEffectivelyPendingRequestIds(
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
      Array.from(activeWorkflowKeyById.entries()).map(([id, key]) => [key, id]),
    );
    const autoGeneratedParentByWorkflowId =
      await UserDbController.getAutoGeneratedWorkflowParentMap(companyId);
    const pendingKeys = new Set<string>();
    const addPendingWorkflowFamilyKeys = (
      workflowId: string | null | undefined,
    ) => {
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
          .filter(
            (nodeId): nodeId is string =>
              typeof nodeId === 'string' && Boolean(nodeId),
          ),
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
    const effectiveIds =
      await UserDbController.filterEffectivelyPendingRequestIds(
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

  private static async getPendingWorkflowOptionsForFetch(
    companyId: string,
    subCategory: string | null,
  ) {
    const pendingRequests = await prisma.workflowReq.findMany({
      where: {
        companyId,
        status: 'PENDING',
        type: { in: ['INITIATE', 'UPDATE'] },
        ...(subCategory ? { subModule: subCategory } : {}),
      },
      select: {
        id: true,
        nodeId: true,
        workflowId: true,
        module: true,
        subModule: true,
        levelsHash: true,
        alias: true,
        data: true,
      },
    });
    const effectiveIds =
      await UserDbController.filterEffectivelyPendingRequestIds(
        'workflow_req',
        pendingRequests.map((request) => request.id),
      );
    const effectiveRequests = pendingRequests.filter((request) =>
      effectiveIds.has(request.id),
    );
    const workflowIds = Array.from(
      new Set(
        effectiveRequests
          .map((request) => request.workflowId)
          .filter(
            (workflowId): workflowId is string =>
              typeof workflowId === 'string' && Boolean(workflowId),
          ),
      ),
    );
    const workflows =
      workflowIds.length > 0
        ? await prisma.workflow.findMany({
            where: { companyId, id: { in: workflowIds } },
            select: {
              id: true,
              name: true,
              alias: true,
              module: true,
              subModule: true,
              levelsHash: true,
              orgStructure: {
                select: { nodePath: true },
              },
            },
          })
        : [];
    const workflowById = new Map(
      workflows.map((workflow) => [workflow.id, workflow]),
    );
    const nodeIds = Array.from(
      new Set(
        effectiveRequests
          .map((request) => request.nodeId)
          .filter(
            (nodeId): nodeId is string =>
              typeof nodeId === 'string' && Boolean(nodeId),
          ),
      ),
    );
    const nodes =
      nodeIds.length > 0
        ? await prisma.orgStructure.findMany({
            where: { companyId, id: { in: nodeIds }, status: 'ACTIVE' },
            select: { id: true, nodePath: true },
          })
        : [];
    const nodePathById = new Map(nodes.map((node) => [node.id, node.nodePath]));
    const pendingByNodePath = new Map<string, CompanyNodeWorkflowOption[]>();
    const seenKeys = new Set<string>();

    effectiveRequests.forEach((request) => {
      const data = (request.data as any) || {};
      const target = data.target || {};
      const workflow = request.workflowId
        ? workflowById.get(request.workflowId)
        : null;
      const nodePath =
        data.nodePath ||
        data.orgStructure?.nodePath ||
        target.nodePath ||
        workflow?.orgStructure?.nodePath ||
        (request.nodeId ? nodePathById.get(request.nodeId) : null);
      const module =
        data.module || target.module || request.module || workflow?.module;
      const requestSubModule =
        data.subModule ||
        target.subModule ||
        request.subModule ||
        workflow?.subModule;
      const levelsHash =
        data.levelsHash ||
        target.levelsHash ||
        request.levelsHash ||
        workflow?.levelsHash;

      if (
        !nodePath ||
        !module ||
        !requestSubModule ||
        !levelsHash ||
        (subCategory && requestSubModule !== subCategory)
      ) {
        return;
      }

      const identityKey = UserDbController.workflowIdentityKey({
        module,
        subModule: requestSubModule,
        nodePath,
        levelsHash,
      });
      if (!identityKey || seenKeys.has(identityKey)) return;
      seenKeys.add(identityKey);

      const workflows = pendingByNodePath.get(nodePath) || [];
      workflows.push({
        id: request.workflowId || request.id,
        levelsHash,
        name: data.name || target.name || workflow?.name || 'Pending Workflow',
        alias: request.alias || data.alias || workflow?.alias || 'N/A',
        status: 'PENDING',
        module,
        subModule: requestSubModule,
        nodePath,
      });
      pendingByNodePath.set(nodePath, workflows);
    });

    return pendingByNodePath;
  }

  private static async getUserAccessVisibilityScope(
    userId: string,
    companyId: string,
    pendingOrgNodePaths: Set<string>,
    subCategory = 'USER_ACC',
  ): Promise<UserAccessVisibilityScope> {
    const globalAccess = await prisma.userAccess.findFirst({
      where: {
        userId,
        companyId,
        isGlobalAccess: true,
      },
      select: { id: true },
    });

    if (globalAccess) {
      const visibleNodes = await prisma.orgStructure.findMany({
        where: {
          companyId,
          status: 'ACTIVE',
          nodePath: { notIn: Array.from(pendingOrgNodePaths) },
        },
        select: {
          id: true,
          nodeName: true,
          nodePath: true,
          nodeType: true,
        },
        orderBy: [{ nodePath: 'asc' }],
      });

      return {
        isGlobal: true,
        visibleNodeIds: visibleNodes.map((node) => node.id),
        visibleNodePaths: visibleNodes.map((node) => node.nodePath),
        visibleNodes: visibleNodes.map((node) => ({
          ...node,
          nodeType: String(node.nodeType),
        })),
      };
    }

    const requesterAccesses = await prisma.userAccess.findMany({
      where: {
        userId,
        companyId,
        role: {
          subCategory,
          view: true,
        },
        orgStructure: {
          status: 'ACTIVE',
          nodePath: { notIn: Array.from(pendingOrgNodePaths) },
        },
      },
      include: {
        orgStructure: {
          select: {
            nodePath: true,
          },
        },
      },
    });

    if (requesterAccesses.length === 0) {
      return {
        isGlobal: false,
        visibleNodeIds: [],
        visibleNodePaths: [],
        visibleNodes: [],
      };
    }

    const nodePaths = requesterAccesses
      .filter((access) => access.accessCategory === 'NODE')
      .map((access) => access.orgStructure.nodePath);
    const immediateChildPaths = requesterAccesses
      .filter((access) => access.accessCategory === 'IMMEDIATE_CHILD')
      .map((access) => access.orgStructure.nodePath);
    const allChildPaths = requesterAccesses
      .filter((access) => access.accessCategory === 'ALL_CHILD')
      .map((access) => access.orgStructure.nodePath);

    const visibleNodes = await prisma.orgStructure.findMany({
      where: {
        companyId,
        status: 'ACTIVE',
        nodePath: { notIn: Array.from(pendingOrgNodePaths) },
        OR: [
          {
            nodePath: {
              in: [...nodePaths, ...immediateChildPaths, ...allChildPaths],
            },
          },
          ...allChildPaths.map((path) => ({
            nodePath: { startsWith: `${path}.` },
          })),
          ...immediateChildPaths.map((path) => ({
            parent: { nodePath: path },
          })),
        ],
      },
      select: {
        id: true,
        nodeName: true,
        nodePath: true,
        nodeType: true,
      },
      orderBy: [{ nodePath: 'asc' }],
    });

    return {
      isGlobal: false,
      visibleNodeIds: visibleNodes.map((node) => node.id),
      visibleNodePaths: visibleNodes.map((node) => node.nodePath),
      visibleNodes: visibleNodes.map((node) => ({
        ...node,
        nodeType: String(node.nodeType),
      })),
    };
  }

  private static async getFetchUserViewerScope(
    userId: string | null | undefined,
    companyId: string,
  ): Promise<FetchUserViewerScope> {
    if (!userId) {
      return {
        isSaasAdmin: false,
        isCorpAdmin: false,
        isGlobal: true,
        visibleNodeIds: [],
        visibleNodePaths: [],
      };
    }

    const adminAccesses = await prisma.userAccess.findMany({
      where: {
        userId,
        companyId,
        OR: [
          { roleCode: 'SAAS_ADMIN' },
          { roleCode: 'CORP_ADMIN' },
          { isGlobalAccess: true },
        ],
      },
      select: {
        roleCode: true,
        isGlobalAccess: true,
      },
    });

    const isSaasAdmin = adminAccesses.some(
      (access) => access.roleCode === 'SAAS_ADMIN',
    );
    const isCorpAdmin = adminAccesses.some(
      (access) => access.roleCode === 'CORP_ADMIN',
    );

    if (
      isSaasAdmin ||
      isCorpAdmin ||
      adminAccesses.some((access) => access.isGlobalAccess)
    ) {
      return {
        isSaasAdmin,
        isCorpAdmin,
        isGlobal: true,
        visibleNodeIds: [],
        visibleNodePaths: [],
      };
    }

    const requesterAccesses = await prisma.userAccess.findMany({
      where: {
        userId,
        companyId,
        role: {
          subCategory: 'USER_ACC',
          view: true,
        },
      },
      include: { orgStructure: { select: { nodePath: true } } },
    });

    if (requesterAccesses.length === 0) {
      return {
        isSaasAdmin: false,
        isCorpAdmin: false,
        isGlobal: false,
        visibleNodeIds: [],
        visibleNodePaths: [],
      };
    }

    const nodePaths = requesterAccesses
      .filter((access) => access.accessCategory === 'NODE')
      .map((access) => access.orgStructure.nodePath);
    const immediateChildPaths = requesterAccesses
      .filter((access) => access.accessCategory === 'IMMEDIATE_CHILD')
      .map((access) => access.orgStructure.nodePath);
    const allChildPaths = requesterAccesses
      .filter((access) => access.accessCategory === 'ALL_CHILD')
      .map((access) => access.orgStructure.nodePath);

    const visibleNodes = await prisma.orgStructure.findMany({
      where: {
        companyId,
        OR: [
          {
            nodePath: {
              in: [...nodePaths, ...immediateChildPaths, ...allChildPaths],
            },
          },
          ...allChildPaths.map((path) => ({
            nodePath: { startsWith: `${path}.` },
          })),
          ...immediateChildPaths.map((path) => ({
            parent: { nodePath: path },
          })),
        ],
      },
      select: { id: true, nodePath: true },
    });

    return {
      isSaasAdmin: false,
      isCorpAdmin: false,
      isGlobal: false,
      visibleNodeIds: visibleNodes.map((node) => node.id),
      visibleNodePaths: visibleNodes.map((node) => node.nodePath),
    };
  }

  private static async buildUserAccFilterDropdowns(
    userId: string,
    companyId: string,
    applied?: unknown,
  ) {
    const pendingOrgNodePaths =
      await UserDbController.getPendingOrgNodePathsForFetch(companyId);
    const visibility = await UserDbController.getUserAccessVisibilityScope(
      userId,
      companyId,
      pendingOrgNodePaths,
    );
    const viewerScope = await UserDbController.getFetchUserViewerScope(
      userId,
      companyId,
    );
    const canViewCorpAdminUsers =
      viewerScope.isSaasAdmin || viewerScope.isCorpAdmin;
    const visibleNodePathSet = new Set(visibility.visibleNodePaths);
    const visibleUserWhere = visibility.isGlobal
      ? canViewCorpAdminUsers
        ? {}
        : {
            userAccesses: {
              none: {
                companyId,
                roleCode: 'CORP_ADMIN',
              },
            },
          }
      : visibility.visibleNodeIds.length > 0
        ? {
            AND: [
              {
                userAccesses: {
                  some: {
                    companyId,
                    nodeId: { in: visibility.visibleNodeIds },
                  },
                },
              },
              {
                userAccesses: {
                  none: {
                    companyId,
                    isGlobalAccess: true,
                  },
                },
              },
              ...(canViewCorpAdminUsers
                ? []
                : [
                    {
                      userAccesses: {
                        none: {
                          companyId,
                          roleCode: 'CORP_ADMIN',
                        },
                      },
                    },
                  ]),
            ],
          }
        : {
            id: '__no_visible_user__',
          };

    const appliedFilters =
      UserDbController.normalizeUserListAppliedFilters(applied);

    const [
      activeUsers,
      inactiveUsers,
      activeCount,
      inactiveCount,
      pendingUsers,
      eligibleCounts,
    ] =
      await Promise.all(
      [
        prisma.user.findMany({
          where: {
            userMappings: {
              some: {
                companyId,
                status: 'ACTIVE',
              },
            },
            ...visibleUserWhere,
          },
          select: {
            id: true,
            userMappings: {
              where: {
                companyId,
                status: 'ACTIVE',
              },
              select: {
                designation: true,
                manager: {
                  select: {
                    name: true,
                    email: true,
                  },
                },
              },
            },
            userAccesses: {
              where: {
                companyId,
                role: {
                  isActive: true,
                },
                orgStructure: {
                  status: 'ACTIVE',
                  nodePath: { notIn: Array.from(pendingOrgNodePaths) },
                },
              },
              select: {
                accessType: true,
                isGlobalAccess: true,
                role: {
                  select: {
                    roleName: true,
                    category: true,
                    subCategory: true,
                    permissionLevel: true,
                    view: true,
                    modify: true,
                    approve: true,
                    initiate: true,
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
        prisma.user.findMany({
          where: {
            userMappings: {
              some: {
                companyId,
                status: 'INACTIVE',
              },
            },
            ...visibleUserWhere,
          },
          select: {
            id: true,
            userMappings: {
              where: {
                companyId,
                status: 'INACTIVE',
              },
              select: {
                designation: true,
                manager: {
                  select: {
                    name: true,
                    email: true,
                  },
                },
              },
            },
            userAccesses: {
              where: {
                companyId,
                role: {
                  isActive: true,
                },
                orgStructure: {
                  status: 'ACTIVE',
                  nodePath: { notIn: Array.from(pendingOrgNodePaths) },
                },
              },
              select: {
                accessType: true,
                isGlobalAccess: true,
                role: {
                  select: {
                    roleName: true,
                    category: true,
                    subCategory: true,
                    permissionLevel: true,
                    view: true,
                    modify: true,
                    approve: true,
                    initiate: true,
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
        prisma.user.count({
          where: {
            userMappings: {
              some: {
                companyId,
                status: 'ACTIVE',
              },
            },
            ...visibleUserWhere,
          },
        }),
        prisma.user.count({
          where: {
            userMappings: {
              some: {
                companyId,
                status: 'INACTIVE',
              },
            },
            ...visibleUserWhere,
          },
        }),
        UserDbController.fetchPendingUserOnboardings({
          resolvedCompanyId: companyId,
          isGlobal: visibility.isGlobal,
          visibleNodePaths: visibility.visibleNodePaths,
          offset: 0,
          limit: 1,
          applyPagination: false,
          page: 1,
          query: null,
          viewerUserId: userId,
        }),
        UserDbController.getPendingApprovalEligibleUserCounts(
          companyId,
          appliedFilters,
        ),
      ],
    );

    const designationCounts = new Map<
      string,
      CompanyNodeFilterDesignationOption
    >();
    const nodeTypeCounts = new Map<string, CompanyNodeFilterNodeTypeOption>();
    const nodeNameMap = new Map<string, CompanyNodeFilterNodeOption>();
    const categoryMap = new Map<string, string>();
    const subCategoryMap = new Map<string, Set<string>>();
    const reportingManagerMap = new Map<string, string>();
    const permissionSummarySets = {
      checker: new Set<string>(),
      maker: new Set<string>(),
      viewer: new Set<string>(),
      corpAdmin: new Set<string>(),
    };
    const allUserEntries = [
      ...activeUsers.map((user) => ({ user, defaultStatus: 'ACTIVE' as const })),
      ...inactiveUsers.map((user) => ({
        user,
        defaultStatus: 'INACTIVE' as const,
      })),
    ];

    const filteredUserEntries = allUserEntries.filter(
      ({ user, defaultStatus }) => {
        const mapping = user.userMappings[0];
        const visibleAccesses = visibility.isGlobal
          ? user.userAccesses
          : user.userAccesses.filter((access) =>
              visibleNodePathSet.has(access.orgStructure.nodePath),
            );
        const primary = visibleAccesses
          .filter(
            (access) =>
              access.isGlobalAccess === true || access.accessType === 'PRIMARY',
          )
          .map((access) => ({
            roleCategory: access.role?.category || '',
            roleSubCategory: access.role?.subCategory || '',
            roleName: access.role?.roleName || '',
            permissionLevel: access.role?.permissionLevel || '',
            nodeName: access.orgStructure?.nodeName || '',
            nodePath: access.orgStructure?.nodePath || '',
            nodeType: access.orgStructure?.nodeType || null,
            canView: access.role?.view || false,
            canModify: access.role?.modify || false,
            canApprove: access.role?.approve || false,
            canInitiate: access.role?.initiate || false,
          }));
        const secondary = visibleAccesses
          .filter(
            (access) =>
              access.isGlobalAccess !== true && access.accessType !== 'PRIMARY',
          )
          .map((access) => ({
            roleCategory: access.role?.category || '',
            roleSubCategory: access.role?.subCategory || '',
            roleName: access.role?.roleName || '',
            permissionLevel: access.role?.permissionLevel || '',
            nodeName: access.orgStructure?.nodeName || '',
            nodePath: access.orgStructure?.nodePath || '',
            nodeType: access.orgStructure?.nodeType || null,
            canView: access.role?.view || false,
            canModify: access.role?.modify || false,
            canApprove: access.role?.approve || false,
            canInitiate: access.role?.initiate || false,
          }));
        const pendingSummary = eligibleCounts.get(user.id);

        return UserDbController.matchesAppliedUserFilters(
          {
            basicDetails: {
              designation: mapping?.designation ?? null,
              reportingManagerName: mapping?.manager?.name ?? null,
              reportingManagerEmail: mapping?.manager?.email ?? null,
              status: defaultStatus,
            },
            primary,
            secondary,
            isPending: false,
          },
          appliedFilters,
          {
            defaultStatus,
            hasPendingOverride: Boolean(pendingSummary?.count),
            pendingApprovalSubCategories: pendingSummary
              ? Array.from(pendingSummary.subCategories)
              : [],
          },
        );
      },
    );

    const filteredUsers = filteredUserEntries.map((entry) => entry.user);
    const filteredActiveUsers = filteredUserEntries.filter(
      (entry) => entry.defaultStatus === 'ACTIVE',
    );
    const filteredInactiveUsers = filteredUserEntries.filter(
      (entry) => entry.defaultStatus === 'INACTIVE',
    );

    const pendingOnboardingRows = (pendingUsers.pendingOnboardings || []) as any[];
    const filteredPendingCount = appliedFilters
      ? (
          await UserDbController.formatPendingUsers(
            pendingOnboardingRows,
            companyId,
            { detail: true },
          )
        ).filter(
          (pendingUser, index) =>
            pendingUser &&
            UserDbController.matchesAppliedUserFilters(
              pendingUser,
              appliedFilters,
              {
                defaultStatus: 'PENDING',
                isPendingRecord: true,
                pendingRequestType: pendingOnboardingRows[index]?.type ?? null,
              },
            ),
        ).length
      : pendingUsers.pendingCount;

    for (const user of filteredUsers) {
      const mapping = user.userMappings[0];
      const designation = UserDbController.normalizeFilterText(
        mapping?.designation,
      );
      if (designation) {
        const key = designation.toLowerCase();
        const current = designationCounts.get(key);
        designationCounts.set(key, {
          value: designation,
          count: (current?.count || 0) + 1,
        });
      }

      const managerName =
        UserDbController.normalizeFilterText(mapping?.manager?.name) ||
        UserDbController.normalizeFilterText(mapping?.manager?.email);
      if (managerName) {
        reportingManagerMap.set(managerName.toLowerCase(), managerName);
      }

      const visibleAccesses = visibility.isGlobal
        ? user.userAccesses
        : user.userAccesses.filter((access) =>
            visibleNodePathSet.has(access.orgStructure.nodePath),
          );

      const userPermissionBuckets = new Set<'checker' | 'maker' | 'viewer'>();

      visibleAccesses.forEach((access) => {
        const accessBucket = UserDbController.resolveAccessRoleBucket({
          permissionLevel: access.role?.permissionLevel,
          canView: access.role?.view,
          canModify: access.role?.modify,
          canApprove: access.role?.approve,
          canInitiate: access.role?.initiate,
        });

        if (accessBucket === 'checker') {
          userPermissionBuckets.add('checker');
        } else if (accessBucket === 'maker') {
          userPermissionBuckets.add('maker');
        } else if (accessBucket === 'user') {
          userPermissionBuckets.add('viewer');
        }

        if (canViewCorpAdminUsers && access.role?.roleName === 'Corp Admin') {
          permissionSummarySets.corpAdmin.add(user.id);
        }
      });

      userPermissionBuckets.forEach((bucket) => {
        permissionSummarySets[bucket].add(user.id);
      });

      for (const access of visibleAccesses) {
        const nodePath = UserDbController.normalizeFilterText(
          access.orgStructure?.nodePath,
        );
        const nodeName = UserDbController.normalizeFilterText(
          access.orgStructure?.nodeName,
        );
        const nodeType = UserDbController.normalizeFilterText(
          access.orgStructure?.nodeType,
        );
        const categoryLabel = UserDbController.humanizeFilterLabel(
          access.role?.category,
        );
        const subCategoryLabel = UserDbController.humanizeFilterLabel(
          access.role?.subCategory,
        );
        const roleName = UserDbController.normalizeFilterText(
          access.role?.roleName,
        );

        if (categoryLabel) {
          categoryMap.set(categoryLabel.toLowerCase(), categoryLabel);
        }

        if (categoryLabel && subCategoryLabel) {
          const categoryKey = categoryLabel.toLowerCase();
          const current = subCategoryMap.get(categoryKey) || new Set<string>();
          current.add(subCategoryLabel);
          subCategoryMap.set(categoryKey, current);
        }

        const nodeTypeLabel = UserDbController.humanizeFilterLabel(nodeType);
        if (nodeTypeLabel) {
          const key = nodeTypeLabel.toLowerCase();
          const current = nodeTypeCounts.get(key);
          nodeTypeCounts.set(key, {
            value: nodeTypeLabel,
            count: (current?.count || 0) + 1,
          });
        }

        if (nodePath) {
          const level = Math.max(nodePath.split('.').filter(Boolean).length, 1);
          const levelCount = level <= 1 ? 'root' : `level${level - 1}`;
          const existingNode = nodeNameMap.get(nodePath.toLowerCase());
          nodeNameMap.set(nodePath.toLowerCase(), {
            value: nodeName || nodePath,
            path: nodePath,
            nodeType,
            level,
            levelCount,
            count: (existingNode?.count || 0) + 1,
            permissionCount: (existingNode?.permissionCount || 0) + 1,
          });
        }
      }
    }

    const nodeType = Array.from(nodeTypeCounts.values()).sort((a, b) =>
      a.value.localeCompare(b.value),
    );
    const nodeName = Array.from(nodeNameMap.values()).sort((a, b) =>
      a.value.localeCompare(b.value),
    );
    const nodes = nodeName.map((node) => ({
      nodeName: node.value,
      nodePath: node.path,
      nodeType:
        UserDbController.humanizeFilterLabel(node.nodeType) || node.nodeType,
      level: node.level || 1,
      levelLabel: String(node.levelCount || 'root').toUpperCase(),
      userCount: node.count || 0,
      permissionCount: node.permissionCount || 0,
    }));

    const category = Array.from(categoryMap.values()).sort((a, b) =>
      a.localeCompare(b),
    );
    const reportingManager = Array.from(reportingManagerMap.values()).sort(
      (a, b) => a.localeCompare(b),
    );
    const subCategoryEntries: Array<[string, string[]]> = Array.from(
      subCategoryMap.entries(),
    ).map(([categoryKey, values]) => [
      categoryMap.get(categoryKey) || categoryKey,
      Array.from(values).sort((a, b) => a.localeCompare(b)),
    ]);
    subCategoryEntries.sort((left, right) => left[0].localeCompare(right[0]));
    const subCategory = Object.fromEntries(subCategoryEntries);
    const userStatusSummary: CompanyNodeFilterUserStatusSummary = {
      active: appliedFilters ? filteredActiveUsers.length : activeCount,
      pending: filteredPendingCount,
      inactive: appliedFilters ? filteredInactiveUsers.length : inactiveCount,
    };
    const permissionSummary: CompanyNodeFilterPermissionSummary = {
      checker: { count: permissionSummarySets.checker.size },
      maker: { count: permissionSummarySets.maker.size },
      viewer: { count: permissionSummarySets.viewer.size },
      corpAdmin: { count: permissionSummarySets.corpAdmin.size },
    };

    return {
      designation: Array.from(designationCounts.values()).sort((a, b) =>
        a.value.localeCompare(b.value),
      ),
      nodeName,
      nodeType,
      category,
      subCategory,
      reportingManager,
      userStatusSummary,
      permissionSummary,
      nodes,
    };
  }

  private static async buildWorkflowFilterDropdowns(
    userId: string,
    companyId: string,
    applied?: unknown,
  ) {
    const [
      pendingOrgNodePaths,
      pendingWorkflowKeys,
      pendingWorkflowOptionsByNodePath,
      autoGeneratedParentByWorkflowId,
    ] = await Promise.all([
      UserDbController.getPendingOrgNodePathsForFetch(companyId),
      UserDbController.getPendingWorkflowKeysForFetch(companyId),
      UserDbController.getPendingWorkflowOptionsForFetch(companyId, null),
      UserDbController.getAutoGeneratedWorkflowParentMap(companyId),
    ]);
    const visibility = await UserDbController.getUserAccessVisibilityScope(
      userId,
      companyId,
      pendingOrgNodePaths,
      'WORK_FLOW',
    );

    const normalizedFilters =
      UserDbController.normalizeWorkflowCompanyFilters(applied);

    if (visibility.visibleNodeIds.length === 0) {
      return {
        filter: true,
        workflowSubCategory: 'WORK_FLOW',
        nodeName: [],
        nodeType: [],
        subCategory: [],
        module: [],
        checker: [],
        workflowLevel: [],
        nodes: [],
      };
    }

    const workflows = await prisma.workflow.findMany({
      where: {
        companyId,
        status: 'ACTIVE',
        nodeId: { in: visibility.visibleNodeIds },
        orgStructure: {
          status: 'ACTIVE',
          nodePath: { notIn: Array.from(pendingOrgNodePaths) },
        },
      },
      select: {
        id: true,
        name: true,
        alias: true,
        module: true,
        subModule: true,
        status: true,
        levelsHash: true,
        orgStructure: {
          select: {
            id: true,
            nodeName: true,
            nodePath: true,
            nodeType: true,
          },
        },
        levels: {
          orderBy: { level: 'asc' },
          select: {
            level: true,
            approver1: true,
            approver2: true,
            approverType: true,
          },
        },
      },
      orderBy: [{ orgStructure: { nodePath: 'asc' } }, { createdAt: 'desc' }],
    });

    const visibleWorkflows = workflows
      .filter((workflow) => {
        if (autoGeneratedParentByWorkflowId.has(workflow.id)) {
          return false;
        }

        const nodePath = workflow.orgStructure?.nodePath || null;
        return !pendingWorkflowKeys.has(
          UserDbController.workflowIdentityKey({
            module: workflow.module,
            subModule: workflow.subModule,
            nodePath,
            levelsHash: workflow.levelsHash,
          }) || '',
        );
      })
      .map((workflow) => {
        const nodePath = workflow.orgStructure?.nodePath || '';
        const nodeSegments = nodePath.split('.').filter(Boolean);
        const hierarchyLevel = Math.max(nodeSegments.length, 1);
        const hierarchyLabel =
          hierarchyLevel <= 1 ? 'ROOT' : `LEVEL${hierarchyLevel - 1}`;
        const levelNumbers = workflow.levels
          .map((level) => Number(level.level))
          .filter((level) => Number.isInteger(level) && level > 0);
        const checkerCount = UserDbController.resolveWorkflowCheckerCount(
          workflow.alias,
          workflow.levels,
        );
        const levelCount = UserDbController.resolveWorkflowLevelCount(
          workflow.alias,
          levelNumbers,
        );

        return {
          nodeId: workflow.orgStructure?.id || '',
          nodeName: workflow.orgStructure?.nodeName || '',
          nodePath,
          nodeType: String(workflow.orgStructure?.nodeType || ''),
          nodeTypeLabel:
            UserDbController.humanizeFilterLabel(
              String(workflow.orgStructure?.nodeType || ''),
            ) || String(workflow.orgStructure?.nodeType || ''),
          hierarchyLevel,
          hierarchyLabel,
          levelsHash: workflow.levelsHash,
          name: workflow.name,
          alias: workflow.alias,
          module: workflow.module,
          moduleLabel:
            UserDbController.humanizeFilterLabel(workflow.module) ||
            workflow.module,
          subModule: workflow.subModule,
          subModuleLabel:
            UserDbController.humanizeFilterLabel(workflow.subModule) ||
            workflow.subModule,
          status: workflow.status,
          checkerCount,
          levelCount,
          levelNumbers,
        };
      });
    const visibleNodeByPath = new Map(
      visibility.visibleNodes.map((node) => [node.nodePath, node]),
    );
    const visiblePendingWorkflows = Array.from(
      pendingWorkflowOptionsByNodePath.entries(),
    ).flatMap(([nodePath, pendingWorkflows]) => {
      const node = visibleNodeByPath.get(nodePath);
      if (!node) return [];

      const nodeSegments = nodePath.split('.').filter(Boolean);
      const hierarchyLevel = Math.max(nodeSegments.length, 1);
      const hierarchyLabel =
        hierarchyLevel <= 1 ? 'ROOT' : `LEVEL${hierarchyLevel - 1}`;

      return pendingWorkflows.map((workflow) => {
        const checkerCount =
          UserDbController.extractWorkflowCheckerCountFromAlias(
            workflow.alias,
          ) || 0;
        const levelCount =
          UserDbController.extractWorkflowLevelCountFromAlias(workflow.alias) ||
          0;
        const levelNumbers =
          levelCount > 0
            ? Array.from({ length: levelCount }, (_, index) => index + 1)
            : [];

        return {
          nodeId: node.id,
          nodeName: node.nodeName,
          nodePath,
          nodeType: String(node.nodeType || ''),
          nodeTypeLabel:
            UserDbController.humanizeFilterLabel(
              String(node.nodeType || ''),
            ) || String(node.nodeType || ''),
          hierarchyLevel,
          hierarchyLabel,
          levelsHash: workflow.levelsHash,
          name: workflow.name,
          alias: workflow.alias,
          module: workflow.module || '',
          moduleLabel:
            UserDbController.humanizeFilterLabel(workflow.module) ||
            workflow.module ||
            '',
          subModule: workflow.subModule || '',
          subModuleLabel:
            UserDbController.humanizeFilterLabel(workflow.subModule) ||
            workflow.subModule ||
            '',
          status: workflow.status || 'PENDING',
          checkerCount,
          levelCount,
          levelNumbers,
        };
      });
    });
    const workflowRows = [...visibleWorkflows, ...visiblePendingWorkflows];

    const filteredWorkflows = normalizedFilters
      ? workflowRows.filter((workflow) => {
          const matchesTextFilter = (
            acceptedValues: string[],
            ...values: Array<string | null | undefined>
          ) => {
            if (acceptedValues.length === 0) return true;
            return values.some((value) => {
              const normalizedValue =
                UserDbController.compactFilterValue(value) || '';
              return acceptedValues.includes(normalizedValue);
            });
          };

          if (
            !matchesTextFilter(
              normalizedFilters.nodeValues,
              workflow.nodeName,
              workflow.nodePath,
            )
          ) {
            return false;
          }

          if (
            !matchesTextFilter(
              normalizedFilters.nodeType,
              workflow.nodeType,
              workflow.nodeTypeLabel,
            )
          ) {
            return false;
          }

          if (
            !matchesTextFilter(
              normalizedFilters.module,
              workflow.module,
              workflow.moduleLabel,
            )
          ) {
            return false;
          }

          if (
            !matchesTextFilter(
              normalizedFilters.subCategory,
              workflow.subModule,
              workflow.subModuleLabel,
            )
          ) {
            return false;
          }

          if (
            normalizedFilters.checkerCounts.length > 0 &&
            !normalizedFilters.checkerCounts.includes(workflow.checkerCount)
          ) {
            return false;
          }

          if (
            normalizedFilters.workflowLevels.length > 0 &&
            !normalizedFilters.workflowLevels.includes(workflow.levelCount)
          ) {
            return false;
          }

          if (normalizedFilters.levels.length > 0) {
            const workflowLevelLabel = UserDbController.compactFilterValue(
              `LEVEL${workflow.levelCount}`,
            );
            if (
              !workflowLevelLabel ||
              !normalizedFilters.levels.includes(workflowLevelLabel)
            ) {
              return false;
            }
          }

          return true;
        })
      : workflowRows;

    const nodeNameMap = new Map<string, CompanyNodeFilterNodeOption>();
    const nodeTypeCounts = new Map<string, CompanyNodeFilterNodeTypeOption>();
    const moduleCounts = new Map<string, { value: string; count: number }>();
    const checkerCounts = new Map<number, { value: number; count: number }>();
    const workflowLevelCounts = new Map<number, { value: number; count: number }>();

      filteredWorkflows.forEach((workflow) => {
        const nodeKey = workflow.nodePath.toLowerCase();
        const existingNode = nodeNameMap.get(nodeKey);
        nodeNameMap.set(nodeKey, {
          value: workflow.nodeName,
          path: workflow.nodePath,
          // Node filter levelCount should represent hierarchy depth, not workflow approval levels.
          levelCount: workflow.hierarchyLevel,
          count: (existingNode?.count || 0) + 1,
        });

      const nodeTypeKey = workflow.nodeTypeLabel.toLowerCase();
      const existingNodeType = nodeTypeCounts.get(nodeTypeKey);
      nodeTypeCounts.set(nodeTypeKey, {
        value: workflow.nodeTypeLabel,
        count: (existingNodeType?.count || 0) + 1,
      });

      const moduleKey = workflow.moduleLabel.toLowerCase();
      const existingModule = moduleCounts.get(moduleKey);
      moduleCounts.set(moduleKey, {
        value: workflow.moduleLabel,
        count: (existingModule?.count || 0) + 1,
      });

      const existingChecker = checkerCounts.get(workflow.checkerCount);
      checkerCounts.set(workflow.checkerCount, {
        value: workflow.checkerCount,
        count: (existingChecker?.count || 0) + 1,
      });

      const existingLevelCount = workflowLevelCounts.get(workflow.levelCount);
      workflowLevelCounts.set(workflow.levelCount, {
        value: workflow.levelCount,
        count: (existingLevelCount?.count || 0) + 1,
      });
    });

    const nodes = Array.from(
      filteredWorkflows.reduce(
        (
          map,
          workflow,
        ) => {
          const existing = map.get(workflow.nodePath) || {
            nodeName: workflow.nodeName,
            nodePath: workflow.nodePath,
            nodeType: workflow.nodeTypeLabel,
            level: workflow.hierarchyLevel,
            levelLabel: workflow.hierarchyLabel,
            modules: new Set<string>(),
            workflows: [],
          };

          existing.modules.add(workflow.moduleLabel);
          existing.workflows.push({
            levelsHash: workflow.levelsHash,
            name: workflow.name,
            alias: workflow.alias,
            module: workflow.moduleLabel,
            subModule: workflow.subModuleLabel,
            status: workflow.status,
            checkerCount: workflow.checkerCount,
            levelCount: workflow.levelCount,
            levels: workflow.levelNumbers.map((level) => ({
              level,
              label: `LEVEL${level}`,
            })),
          });

          map.set(workflow.nodePath, existing);
          return map;
        },
        new Map<
          string,
          {
            nodeName: string;
            nodePath: string;
            nodeType: string;
            level: number;
            levelLabel: string;
            modules: Set<string>;
            workflows: Array<{
              levelsHash: string;
              name: string;
              alias: string;
              module: string;
              subModule: string;
              status: string;
              checkerCount: number;
              levelCount: number;
              levels: Array<{ level: number; label: string }>;
            }>;
          }
        >(),
      ).values(),
    )
      .map((node) => ({
        nodeName: node.nodeName,
        nodePath: node.nodePath,
        nodeType: node.nodeType,
        level: node.level,
        levelLabel: node.levelLabel,
        workflowCount: node.workflows.length,
        moduleCount: node.modules.size,
        workflows: node.workflows.sort((left, right) =>
          left.name.localeCompare(right.name),
        ),
      }))
      .sort((left, right) => left.nodePath.localeCompare(right.nodePath));
    const subCategory = Array.from(
      new Set(
        filteredWorkflows
          .map((workflow) => workflow.subModuleLabel)
          .filter((value): value is string => Boolean(value)),
      ),
    ).sort((a, b) => a.localeCompare(b));

    return {
      filter: true,
      workflowSubCategory: 'WORK_FLOW',
      nodeName: Array.from(nodeNameMap.values()).sort((a, b) =>
        a.value.localeCompare(b.value),
      ),
      nodeType: Array.from(nodeTypeCounts.values()).sort((a, b) =>
        a.value.localeCompare(b.value),
      ),
      subCategory,
      module: Array.from(moduleCounts.values()).sort((a, b) =>
        a.value.localeCompare(b.value),
      ),
      checker: Array.from(checkerCounts.values()).sort(
        (a, b) => a.value - b.value,
      ),
      workflowLevel: Array.from(workflowLevelCounts.values()).sort(
        (a, b) => a.value - b.value,
      ),
      nodes,
    };
  }

  private static normalizePageDirection(value: unknown): 'next' | 'prev' {
    return typeof value === 'string' &&
      ['prev', 'previous'].includes(value.trim().toLowerCase())
      ? 'prev'
      : 'next';
  }

  private static getCursorDate(
    row:
      | { id: string; createdAt?: Date | null; updatedAt?: Date | null }
      | null
      | undefined,
  ) {
    if (!row) return null;

    const value = row.updatedAt ?? row.createdAt ?? null;
    return value instanceof Date ? value : null;
  }

  private static encodeCursor(
    row?: {
      id: string;
      createdAt?: Date | null;
      updatedAt?: Date | null;
    } | null,
  ) {
    if (!row) return null;
    const sortAt = UserDbController.getCursorDate(row);
    if (!sortAt) return null;

    return Buffer.from(
      JSON.stringify({
        id: row.id,
        createdAt: sortAt.toISOString(),
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
      const createdAt = new Date(payload.createdAt ?? payload.sortAt);
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
    cursor: {
      id: string;
      createdAt?: Date | null;
      updatedAt?: Date | null;
    } | null,
    direction: 'older' | 'newer',
    timeField: 'createdAt' | 'updatedAt' = 'createdAt',
  ) {
    if (!cursor) return where;
    const cursorDate = UserDbController.getCursorDate(cursor);
    if (!cursorDate) return where;

    const createdAtOperator = direction === 'older' ? 'lt' : 'gt';
    const idOperator = direction === 'older' ? 'lt' : 'gt';

    return {
      AND: [
        where,
        {
          OR: [
            { [timeField]: { [createdAtOperator]: cursorDate } },
            {
              [timeField]: cursorDate,
              id: { [idOperator]: cursor.id },
            },
          ],
        },
      ],
    };
  }

  private static buildPageInfo(
    rows: Array<{ id: string; createdAt?: Date; updatedAt?: Date }>,
    limit: number,
    requestedTopCursor: string | null,
    newCount: number,
    direction: 'next' | 'prev',
    cursor: {
      id: string;
      createdAt?: Date | null;
      updatedAt?: Date | null;
    } | null,
    page: number,
    isPagePagination = false,
    timeField: 'createdAt' | 'updatedAt' = 'createdAt',
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
    row: { id: string; createdAt?: Date; updatedAt?: Date },
    cursor: { id: string; createdAt?: Date | null; updatedAt?: Date | null },
    direction: 'older' | 'newer',
    timeField: 'createdAt' | 'updatedAt' = 'createdAt',
  ) {
    const rowDate =
      timeField === 'updatedAt'
        ? row.updatedAt || row.createdAt
        : row.createdAt || row.updatedAt;
    const cursorDate = UserDbController.getCursorDate(cursor);
    if (!(rowDate instanceof Date) || !cursorDate) {
      return false;
    }

    const rowTime = rowDate.getTime();
    const cursorTime = cursorDate.getTime();

    if (direction === 'older') {
      return (
        rowTime < cursorTime || (rowTime === cursorTime && row.id < cursor.id)
      );
    }

    return (
      rowTime > cursorTime || (rowTime === cursorTime && row.id > cursor.id)
    );
  }

  private static getPageOrder(
    direction: 'next' | 'prev',
    timeField: 'createdAt' | 'updatedAt' = 'createdAt',
  ): any[] {
    return direction === 'prev'
      ? [{ [timeField]: 'asc' }, { id: 'asc' }]
      : [{ [timeField]: 'desc' }, { id: 'desc' }];
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
    const effectiveIds =
      await UserDbController.filterEffectivelyPendingRequestIds(
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
      return typeof targetNodePath === 'string' && targetNodePath === nodePath;
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
    const effectiveIds =
      await UserDbController.filterEffectivelyPendingRequestIds(
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
    const effectiveIds =
      await UserDbController.filterEffectivelyPendingRequestIds(
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

  private static formatUserAccess(access: any, includeNodeType = true) {
    return {
      roleCategory: access.role?.category ?? access.roleCategory,
      roleSubCategory: access.role?.subCategory ?? access.roleSubCategory,
      roleName: access.role?.roleName ?? access.roleName ?? access.roleCode,
      permissionLevel: access.role?.permissionLevel ?? access.permissionLevel,
      canView: Boolean(access.role?.view),
      canModify: Boolean(access.role?.modify),
      canApprove: Boolean(access.role?.approve),
      canInitiate: Boolean(access.role?.initiate),
      nodeName: access.orgStructure?.nodeName ?? access.nodeName,
      nodePath: access.orgStructure?.nodePath ?? access.nodePath,
      ...(includeNodeType
        ? { nodeType: access.orgStructure?.nodeType ?? access.nodeType }
        : {}),
      accessCategory: access.accessCategory,
    };
  }

  private static getNodeHierarchyLevelCount(nodePath: unknown) {
    if (typeof nodePath !== 'string') return null;

    const segments = nodePath
      .split('.')
      .map((segment) => segment.trim())
      .filter(Boolean);

    return Math.max(segments.length, 1);
  }

  private static formatProductionUser(
    u: any,
    pendingRequest?: any,
    options: {
      detail?: boolean;
      pendingApprovalCount?: number;
      includePendingApprovalCount?: boolean;
    } = {},
  ) {
    const mapping = u.userMappings[0];
    const detail = options.detail === true;
    const pendingApprovalCount = Number(options.pendingApprovalCount) || 0;
    const includePendingApprovalCount =
      options.includePendingApprovalCount === true;
    const summaryPrimaryAccess = u.userAccesses.find(
      (a: any) => a.accessType === 'PRIMARY' || a.isGlobalAccess,
    );
    const primary = u.userAccesses
      .filter((a: any) => a.accessType === 'PRIMARY' || a.isGlobalAccess)
      .map((access: any) => UserDbController.formatUserAccess(access, detail));
    const secondary = detail
      ? u.userAccesses
          .filter((a: any) => a.accessType === 'SECONDARY' && !a.isGlobalAccess)
          .map((access: any) => UserDbController.formatUserAccess(access, true))
      : [];
    const resolvedNodePath =
      primary[0]?.nodePath ?? summaryPrimaryAccess?.orgStructure?.nodePath ?? null;
    const levelCount =
      UserDbController.getNodeHierarchyLevelCount(resolvedNodePath);

    return {
      isPending: Boolean(pendingRequest),
      levelCount,
      ...(includePendingApprovalCount ? { pendingApprovalCount } : {}),
      basicDetails: {
        name: u.name,
        email: u.email,
        phone: u.phone,
        designation: mapping?.designation || null,
        nodeType: summaryPrimaryAccess?.orgStructure?.nodeType || null,
        ...(!detail
          ? {
              nodeName:
                primary[0]?.nodeName ??
                summaryPrimaryAccess?.orgStructure?.nodeName ??
                null,
              nodePath: resolvedNodePath,
            }
          : {}),
        ...(detail
          ? {
              createdAt: u.createdAt,
              employeeId: mapping?.employeeId || null,
              reportingManagerName: mapping?.manager?.name || null,
              reportingManagerEmail: mapping?.manager?.email || null,
            }
          : {}),
      },
      ...(detail ? { primary, secondary } : {}),
    };
  }

  private static matchesPendingUserSearch(
    onboarding: any,
    query: string | null,
    existingUser?: any,
  ) {
    if (!query) return true;

    const basicDetails = (onboarding.data as any)?.basicDetails || {};
    const existingMapping = existingUser?.userMappings?.[0];
    const targetEmail =
      (onboarding.data as any)?.targetUserEmail || basicDetails.email;
    const normalizedQuery = query.toLowerCase();

    return [
      basicDetails.name,
      basicDetails.email,
      basicDetails.designation,
      basicDetails.phone,
      targetEmail,
      existingUser?.name,
      existingUser?.email,
      existingUser?.phone,
      existingMapping?.designation,
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
    const visibleRequestIds = new Set(
      await UserDbController.getCurrentApproverRequestIds(
        'user_onboarding',
        viewerUserId,
        resolvedCompanyId,
      ),
    );

    if (isGlobal && !query) {
      const where = {
        status: 'PENDING' as const,
        companyId: resolvedCompanyId,
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
      visibleRequestIds.size === 0 &&
      !viewerUserId
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

    const where = {
      status: 'PENDING' as const,
      companyId: resolvedCompanyId,
    };

    const allPendingOnboardings = await prisma.userOnboarding.findMany({
      where,
      orderBy: UserDbController.getPageOrder(effectiveDirection),
    });
    const pendingTargetEmails = Array.from(
      new Set(
        allPendingOnboardings
          .map((onboarding) =>
            UserDbController.normalizeEmail(
              UserDbController.extractUserTargetEmail(onboarding.data),
            ),
          )
          .filter(Boolean),
      ),
    );
    const pendingExistingUsers =
      pendingTargetEmails.length > 0
        ? await prisma.user.findMany({
            where: {
              email: { in: pendingTargetEmails },
              userMappings: {
                some: {
                  companyId: resolvedCompanyId,
                },
              },
            },
            select: {
              name: true,
              email: true,
              phone: true,
              userMappings: {
                where: { companyId: resolvedCompanyId },
                select: { designation: true },
              },
            },
          })
        : [];
    const pendingExistingUserMap = new Map(
      pendingExistingUsers.map((user) => [
        UserDbController.normalizeEmail(user.email),
        user,
      ]),
    );
    const visiblePendingOnboardings = allPendingOnboardings.filter((onb) => {
      const targetEmail = UserDbController.normalizeEmail(
        UserDbController.extractUserTargetEmail(onb.data),
      );
      const existingUser = pendingExistingUserMap.get(targetEmail);
      return (
        UserDbController.isPendingUserRequestVisible({
          onboarding: onb,
          isGlobal,
          visibleNodePaths,
          viewerUserId,
          visibleRequestIds,
        }) &&
        UserDbController.matchesPendingUserSearch(onb, query, existingUser)
      );
    });
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
    options: { detail?: boolean } = {},
  ) {
    const detail = options.detail === true;
    const pendingEmails = pendingOnboardings
      .map((onb: any) => {
        const data = onb.data as any;
        return data?.targetUserEmail || data?.basicDetails?.email;
      })
      .filter(Boolean);

    const histories =
      detail && pendingEmails.length > 0
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
      detail && managerEmails.length > 0
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
      detail && workflowIds.length > 0
        ? await prisma.workflow.findMany({
            where: { id: { in: workflowIds } },
            select: { id: true, name: true, alias: true },
          })
        : [];
    const workflowMap = new Map(workflowDetails.map((w) => [w.id, w]));
    const pendingRequestIds = pendingOnboardings
      .map((onb: any) => onb.id)
      .filter((id: any): id is string => typeof id === 'string' && Boolean(id));
    const workflowApproverRows =
      pendingRequestIds.length > 0
        ? await prisma.workflowApprover.findMany({
            where: {
              reqId: { in: pendingRequestIds },
              reqTable: 'user_onboarding',
              status: 'PENDING',
            },
            orderBy: [{ reqId: 'asc' }, { level: 'asc' }],
            select: {
              reqId: true,
              level: true,
              approversList: true,
              status: true,
            },
          })
        : [];
    const workflowApproverMap = new Map<string, any[]>();
    workflowApproverRows.forEach((row: any) => {
      const existing = workflowApproverMap.get(row.reqId) || [];
      existing.push(row);
      workflowApproverMap.set(row.reqId, existing);
    });
    const allEligibleApproverIds = new Set<string>();
    pendingOnboardings.forEach((onb: any) => {
      const levels = workflowApproverMap.get(onb.id) || [];
      const pendingLevel = levels.find(
        (level: any) => level.status === 'PENDING',
      );
      const approverIds =
        pendingLevel && Array.isArray(pendingLevel.approversList)
          ? (pendingLevel.approversList as string[])
          : Array.isArray(onb.eligibleApprovers)
            ? (onb.eligibleApprovers as string[])
            : [];
      approverIds.forEach((id: unknown) => {
        if (typeof id === 'string' && id.trim()) {
          allEligibleApproverIds.add(id.trim());
        }
      });
    });
    const eligibleApproverUsers =
      allEligibleApproverIds.size > 0
        ? await prisma.user.findMany({
            where: { id: { in: Array.from(allEligibleApproverIds) } },
            select: { id: true, name: true, email: true },
          })
        : [];
    const eligibleApproverMap = new Map(
      eligibleApproverUsers.map((user) => [
        user.id,
        {
          name: user.name || 'System',
          email: user.email || 'system@internal',
        },
      ]),
    );

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
      existingUsers.map((user) => [
        String(user.email || '').toLowerCase(),
        user,
      ]),
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
            select: {
              nodeName: true,
              nodePath: true,
              nodeType: true,
            },
          })
        : [];
    const activeIncomingNodeMap = new Map(
      activeIncomingNodes.map((node) => [
        String(node.nodePath || '').toLowerCase(),
        node,
      ]),
    );
    const activeIncomingNodePaths = new Set(
      activeIncomingNodes.map((node) => node.nodePath),
    );
    const hasActivePermissionNode = (permission: any) =>
      typeof permission?.nodePath !== 'string' ||
      activeIncomingNodePaths.has(permission.nodePath);
    const pendingEmailFilters = pendingEmails.flatMap((email: string) => [
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
    ]);
    const relatedPendingRequests =
      detail && pendingEmailFilters.length > 0
        ? await prisma.userOnboarding.findMany({
            where: {
              companyId: resolvedCompanyId,
              status: 'PENDING',
              OR: pendingEmailFilters,
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          })
        : pendingOnboardings;

    return Promise.all(
      pendingOnboardings.map(async (onb: any) => {
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
        const levels = workflowApproverMap.get(onb.id) || [];
        const pendingLevel = levels.find(
          (level: any) => level.status === 'PENDING',
        );
        const eligibleApproverIds =
          pendingLevel && Array.isArray(pendingLevel.approversList)
            ? (pendingLevel.approversList as string[])
            : Array.isArray(onb.eligibleApprovers)
              ? (onb.eligibleApprovers as string[])
              : [];
        const eligibleapprovers = eligibleApproverIds
          .map((id: string) => eligibleApproverMap.get(id))
          .filter(Boolean);

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
            permissionLevel: access.role?.permissionLevel || '',
            nodeName: access.orgStructure?.nodeName || '',
            nodePath: access.orgStructure?.nodePath || '',
            nodeType: access.orgStructure?.nodeType || null,
            accessCategory: access.accessCategory || null,
            accessType: access.accessType || 'SECONDARY',
            isGlobalAccess: access.isGlobalAccess || false,
            nodeStatus: access.orgStructure?.status || null,
          }),
        );
        const existingActivePermissions = existingPermissions.filter(
          (permission: any) => permission.nodeStatus === 'ACTIVE',
        );
        const existingSnapshot: UserDataSnapshot | null = existingUser
          ? {
              basicDetails: {
                name: existingUser.name || '',
                email: existingUser.email || '',
                phone: existingUser.phone || '',
                designation: existingMapping?.designation ?? null,
                employeeId: existingMapping?.employeeId ?? null,
                reportingManager: existingMapping?.manager?.email ?? null,
                status: existingMapping?.status || 'ACTIVE',
              },
              permissions: existingActivePermissions.map((permission: any) =>
                UserDbController.normalizePermission(permission),
              ),
            }
          : null;
        const relatedRequestsForUser = relatedPendingRequests.filter(
          (request: any) => {
            const requestEmail =
              UserDbController.extractUserTargetEmail(request.data) || '';
            return (
              request.id === onb.id ||
              requestEmail === String(historyEmail || '').toLowerCase()
            );
          },
        );
        const resolvedSnapshot = detail
          ? UserDbController.buildPendingUserSnapshotAroundRequest(
              relatedRequestsForUser,
              onb,
              existingSnapshot,
            )
          : { oldData: null, newData: null };
        const resolvedOldData = resolvedSnapshot.oldData;
        const resolvedNewData = resolvedSnapshot.newData;
        const effectivePermissions =
          detail && resolvedNewData?.permissions
            ? resolvedNewData.permissions
            : incomingPermissions.length > 0
              ? isInitiate || existingPermissions.length === 0
                ? incomingPermissions.filter(
                    (permission: any) =>
                      !UserDbController.isPermissionRemoval(permission) &&
                      hasActivePermissionNode(permission),
                  )
                : UserDbController.mergePermissionMutations(
                    existingActivePermissions,
                    incomingPermissions.filter(hasActivePermissionNode),
                  )
              : existingPermissions.filter(
                  (permission: any) => permission.nodeStatus === 'ACTIVE',
                );
        const normalizedEffectivePermissions = effectivePermissions.map(
          (permission: any) => {
            const nodePathKey =
              typeof permission?.nodePath === 'string'
                ? permission.nodePath.toLowerCase()
                : '';
            const nodeFromDb = nodePathKey
              ? activeIncomingNodeMap.get(nodePathKey)
              : null;

            return {
              ...permission,
              nodeName: nodeFromDb?.nodeName || permission?.nodeName || '',
              nodePath: nodeFromDb?.nodePath || permission?.nodePath || '',
              nodeType: nodeFromDb?.nodeType || permission?.nodeType || null,
            };
          },
        );
        const responseOldData =
          detail && !isInitiate
            ? await HistoryUserUtil.enrichUserHistoryOldData(resolvedOldData)
            : null;
        const responseNewData =
          detail && !isInitiate
            ? HistoryUserUtil.formatUserHistoryDetailNewData({
                requestData: dataBlob,
                requestOldData: onb.oldData,
                resolvedOldData,
                resolvedNewData,
                requestType: type,
              })
            : null;

        normalizedEffectivePermissions.forEach((p: any) => {
          const access = {
            roleCategory: p.roleCategory,
            roleSubCategory: p.roleSubCategory,
            roleName: p.roleName,
            permissionLevel: p.permissionLevel,
            nodeName: p.nodeName,
            nodePath: p.nodePath,
            ...(detail ? { nodeType: p.nodeType } : {}),
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
        const summaryPrimaryAccess = normalizedEffectivePermissions.find(
          (permission: any) =>
            permission.isGlobal === true ||
            permission.isGlobalAccess === true ||
            permission.accessType === 'PRIMARY',
        );
        const resolvedNodePath =
          primary[0]?.nodePath ?? summaryPrimaryAccess?.nodePath ?? null;
        const levelCount =
          UserDbController.getNodeHierarchyLevelCount(resolvedNodePath);

        return {
          id: onb.id,
          type,
          impact: onb.impact || null,
          levelCount,
          ...(detail
            ? {
                oldData: responseOldData,
                newData: responseNewData,
                approver: approve?.user || null,
              }
            : {}),
          basicDetails: {
            name: basic.name ?? existingUser?.name ?? null,
            email: basic.email ?? existingUser?.email ?? null,
            phone: basic.phone ?? existingUser?.phone ?? null,
            designation:
              basic.designation !== undefined
                ? basic.designation
                : (existingMapping?.designation ?? null),
            nodeType: summaryPrimaryAccess?.nodeType || null,
            ...(!detail
              ? {
                  nodeName:
                    primary[0]?.nodeName ??
                    summaryPrimaryAccess?.nodeName ??
                    null,
                  nodePath: resolvedNodePath,
                }
              : {}),
            ...(detail
              ? {
                  createdAt: onb.createdAt,
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
                    managerInfo?.email ||
                    existingMapping?.manager?.email ||
                    null,
                  initiatorName: init?.user?.name || null,
                  initiatorEmail: init?.user?.email || null,
                  initiatedDate: onb.createdAt,
                  workflowName: w?.name || 'N/A',
                  alias: w?.alias || 'N/A',
                }
              : {}),
          },
          ...(detail ? { primary, secondary } : {}),
        };
      }),
    );
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
      const { companyCode, companyId, userId } = req.body;
      const paginationInput =
        req.body?.pagination &&
        typeof req.body.pagination === 'object' &&
        !Array.isArray(req.body.pagination)
          ? req.body.pagination
          : req.body;
      const requestedListType = UserDbController.normalizeFilterText(
        paginationInput?.statusType ?? req.body?.statusType,
      )?.toLowerCase();
      if (
        requestedListType &&
        !['active', 'pending', 'inactive', 'archive'].includes(
          requestedListType,
        )
      ) {
        throw new AppError('Invalid statusType', 400);
      }
      const listType =
        requestedListType &&
        ['active', 'pending', 'inactive', 'archive'].includes(requestedListType)
          ? (requestedListType as 'active' | 'pending' | 'inactive' | 'archive')
          : undefined;
      const query = UserDbController.normalizeFilterText(
        paginationInput?.query,
      );
      const pagination = getPagination(paginationInput);
      const rawPage = Number(paginationInput?.page);
      const requestedPage =
        paginationInput?.page !== null &&
        paginationInput?.page !== undefined &&
        Number.isFinite(rawPage) &&
        rawPage > 0
          ? Math.floor(rawPage)
          : null;
      const limit = pagination.limit;
      const pageDirection = UserDbController.normalizePageDirection(
        paginationInput?.direction,
      );
      const rawCursor =
        paginationInput?.cursor ??
        (pageDirection === 'prev'
          ? paginationInput?.prevCursor
          : paginationInput?.nextCursor) ??
        paginationInput?.cursorId ??
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
        : paginationInput?.topCursor || null;
      const cursor = isPagePagination
        ? null
        : UserDbController.decodeCursor(requestedCursor);
      const topCursor = isPagePagination
        ? null
        : UserDbController.decodeCursor(requestedTopCursor);
      const effectiveDirection = cursor ? pageDirection : 'next';
      const filterEnabled = req.body?.filter === true;
      const appliedFilters = filterEnabled
        ? UserDbController.normalizeUserListAppliedFilters(req.body?.applied)
        : null;
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

      const viewerScope = await UserDbController.getFetchUserViewerScope(
        userId,
        resolvedCompanyId,
      );
      const isGlobal = viewerScope.isGlobal;
      const allVisibleNodeIds = viewerScope.visibleNodeIds;
      const allVisibleNodePaths = viewerScope.visibleNodePaths;
      const excludeSaasAdminsForViewer =
        viewerScope.isCorpAdmin && !viewerScope.isSaasAdmin;
      const excludeCorpAdminsForViewer =
        !viewerScope.isCorpAdmin && !viewerScope.isSaasAdmin;

      const buildUserWhere = (status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVE') => ({
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
          ? excludeSaasAdminsForViewer
            ? {
                userAccesses: {
                  none: {
                    companyId: resolvedCompanyId,
                    roleCode: 'SAAS_ADMIN',
                  },
                },
              }
            : excludeCorpAdminsForViewer
              ? {
                  userAccesses: {
                    none: {
                      companyId: resolvedCompanyId,
                      roleCode: 'CORP_ADMIN',
                    },
                  },
                }
              : {}
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
                ...(excludeSaasAdminsForViewer
                  ? [
                      {
                        userAccesses: {
                          none: {
                            companyId: resolvedCompanyId,
                            roleCode: 'SAAS_ADMIN',
                          },
                        },
                      },
                    ]
                  : []),
                ...(excludeCorpAdminsForViewer
                  ? [
                      {
                        userAccesses: {
                          none: {
                            companyId: resolvedCompanyId,
                            roleCode: 'CORP_ADMIN',
                          },
                        },
                      },
                    ]
                  : []),
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
          where: {
            companyId: resolvedCompanyId,
            OR: [{ accessType: 'PRIMARY' as const }, { isGlobalAccess: true }],
          },
          include: {
            role: true,
            orgStructure: true,
          },
        },
      };

      if (filterEnabled && appliedFilters) {
        const includePendingApprovalCount = appliedFilters.hasPending !== null;
        const fullUserInclude = {
          userMappings: {
            where: { companyId: resolvedCompanyId },
            include: {
              company: true,
              manager: true,
            },
          },
          userAccesses: {
            where: {
              companyId: resolvedCompanyId,
            },
            include: {
              role: true,
              orgStructure: true,
            },
          },
        };
        const pendingApprovalEligibleUsers =
          await UserDbController.getPendingApprovalEligibleUserCounts(
            resolvedCompanyId,
            appliedFilters,
          );

        const [
          allActiveRows,
          allInactiveRows,
          allArchiveRows,
          allPendingRaw,
          queryMatchedPendingRaw,
        ] = await Promise.all([
          prisma.user.findMany({
            where: buildUserWhere('ACTIVE'),
            include: fullUserInclude,
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          }),
          prisma.user.findMany({
            where: buildUserWhere('INACTIVE'),
            include: fullUserInclude,
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          }),
          prisma.user.findMany({
            where: buildUserWhere('ARCHIVE'),
            include: fullUserInclude,
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          }),
          UserDbController.fetchPendingUserOnboardings({
            resolvedCompanyId,
            isGlobal,
            visibleNodePaths: allVisibleNodePaths,
            offset: 0,
            limit: Math.max(limit, 1),
            applyPagination: false,
            page: 1,
            query: null,
            viewerUserId: userId,
          }),
          UserDbController.fetchPendingUserOnboardings({
            resolvedCompanyId,
            isGlobal,
            visibleNodePaths: allVisibleNodePaths,
            offset: 0,
            limit: Math.max(limit, 1),
            applyPagination: false,
            page: 1,
            query,
            viewerUserId: userId,
          }),
        ]);

        const pendingByEmail = new Map<string, any>();
        (allPendingRaw.pendingOnboardings || []).forEach((request: any) => {
          const email = UserDbController.normalizeEmail(
            UserDbController.extractUserTargetEmail(request.data),
          );
          if (email && !pendingByEmail.has(email)) {
            pendingByEmail.set(email, request);
          }
        });
        const productionPendingByEmail =
          await UserDbController.getEffectivePendingUserRequestsByEmail(
            resolvedCompanyId,
            [
              ...allActiveRows.map((user: any) => user.email),
              ...allInactiveRows.map((user: any) => user.email),
              ...allArchiveRows.map((user: any) => user.email),
            ],
          );

        const filteredActiveUsersDetailed = allActiveRows
          .map((user: any) => ({
            raw: user,
            detail: UserDbController.formatProductionUser(
              user,
              productionPendingByEmail.get(
                UserDbController.normalizeEmail(user.email) || '',
              ),
              { detail: true },
            ),
          }))
          .filter((item) =>
            UserDbController.matchesAppliedUserFilters(
              item.detail,
              appliedFilters,
              {
                defaultStatus: 'ACTIVE',
                pendingRequestType:
                  pendingByEmail.get(
                    UserDbController.normalizeEmail(item.raw.email) || '',
                  )?.type ??
                  productionPendingByEmail.get(
                    UserDbController.normalizeEmail(item.raw.email) || '',
                  )?.type,
                hasPendingOverride:
                  (pendingApprovalEligibleUsers.get(item.raw.id)?.count || 0) >
                  0,
                pendingApprovalSubCategories: Array.from(
                  pendingApprovalEligibleUsers.get(item.raw.id)
                    ?.subCategories || [],
                ),
              },
            ),
          );
        const filteredInactiveUsersDetailed = allInactiveRows
          .map((user: any) => ({
            raw: user,
            detail: UserDbController.formatProductionUser(
              user,
              productionPendingByEmail.get(
                UserDbController.normalizeEmail(user.email) || '',
              ),
              { detail: true },
            ),
          }))
          .filter((item) =>
            UserDbController.matchesAppliedUserFilters(
              item.detail,
              appliedFilters,
              {
                defaultStatus: 'INACTIVE',
                pendingRequestType:
                  pendingByEmail.get(
                    UserDbController.normalizeEmail(item.raw.email) || '',
                  )?.type ??
                  productionPendingByEmail.get(
                    UserDbController.normalizeEmail(item.raw.email) || '',
                  )?.type,
                hasPendingOverride:
                  (pendingApprovalEligibleUsers.get(item.raw.id)?.count || 0) >
                  0,
                pendingApprovalSubCategories: Array.from(
                  pendingApprovalEligibleUsers.get(item.raw.id)
                    ?.subCategories || [],
                ),
              },
            ),
          );
        const filteredArchiveUsersDetailed = allArchiveRows
          .map((user: any) => ({
            raw: user,
            detail: UserDbController.formatProductionUser(
              user,
              productionPendingByEmail.get(
                UserDbController.normalizeEmail(user.email) || '',
              ),
              { detail: true },
            ),
          }))
          .filter((item) =>
            UserDbController.matchesAppliedUserFilters(
              item.detail,
              appliedFilters,
              {
                defaultStatus: 'ARCHIVE',
                pendingRequestType:
                  pendingByEmail.get(
                    UserDbController.normalizeEmail(item.raw.email) || '',
                  )?.type ??
                  productionPendingByEmail.get(
                    UserDbController.normalizeEmail(item.raw.email) || '',
                  )?.type,
                hasPendingOverride:
                  (pendingApprovalEligibleUsers.get(item.raw.id)?.count || 0) >
                  0,
                pendingApprovalSubCategories: Array.from(
                  pendingApprovalEligibleUsers.get(item.raw.id)
                    ?.subCategories || [],
                ),
              },
            ),
          );

        const queryMatchedPendingRows =
          queryMatchedPendingRaw.pendingOnboardings || [];
        const allPendingFormatted = await UserDbController.formatPendingUsers(
          queryMatchedPendingRows,
          resolvedCompanyId,
          { detail: true },
        );
        const filteredPendingUsersDetailed = queryMatchedPendingRows
          .map((row: any, index: number) => ({
            raw: row,
            detail: allPendingFormatted[index],
          }))
          .filter(
            (item: any) =>
              item.detail &&
              UserDbController.matchesAppliedUserFilters(
                item.detail,
                appliedFilters,
                {
                  defaultStatus: 'PENDING',
                  isPendingRecord: true,
                  pendingRequestType: item.raw?.type,
                },
              ),
          );

        const activeCount = filteredActiveUsersDetailed.length;
        const inactiveCount = filteredInactiveUsersDetailed.length;
        const archiveCount = filteredArchiveUsersDetailed.length;
        const pendingCount = filteredPendingUsersDetailed.length;
        const isProductionStatusType =
          listType === 'active' ||
          listType === 'inactive' ||
          listType === 'archive';
        const selectedRowsSource = isProductionStatusType
          ? listType === 'inactive'
            ? filteredInactiveUsersDetailed
            : listType === 'archive'
              ? filteredArchiveUsersDetailed
              : filteredActiveUsersDetailed
          : filteredPendingUsersDetailed;
        const cursorFilteredRows = selectedRowsSource.filter((row: any) =>
          cursor
            ? UserDbController.isRowInCursorDirection(
                isProductionStatusType ? row.raw : row,
                cursor,
                effectiveDirection === 'prev' ? 'newer' : 'older',
                isProductionStatusType ? 'updatedAt' : 'createdAt',
              )
            : true,
        );
        const selectedNewCount = topCursor
          ? selectedRowsSource.filter((row: any) =>
              UserDbController.isRowInCursorDirection(
                isProductionStatusType ? row.raw : row,
                topCursor,
                'newer',
                isProductionStatusType ? 'updatedAt' : 'createdAt',
              ),
            ).length
          : 0;
        const pagedSelection = cursorFilteredRows.slice(
          cursor ? 0 : offset,
          (cursor ? 0 : offset) + limit + 1,
        );
        const selectedPage = UserDbController.buildPageInfo(
          pagedSelection.map((row: any) => row.raw),
          limit,
          requestedTopCursor,
          selectedNewCount,
          effectiveDirection,
          cursor,
          page,
          isPagePagination,
          isProductionStatusType ? 'updatedAt' : 'createdAt',
        );

        const firstSelectedPageRow = selectedPage.pageRows[0];
        if (!isPagePagination && cursor && firstSelectedPageRow) {
          const newerCount = selectedRowsSource.filter((row: any) =>
            UserDbController.isRowInCursorDirection(
              isProductionStatusType ? row.raw : row,
              firstSelectedPageRow,
              'newer',
              isProductionStatusType ? 'updatedAt' : 'createdAt',
            ),
          ).length;
          selectedPage.pageInfo.page = Math.floor(newerCount / limit) + 1;
        }

        const pageIdSet = new Set(
          selectedPage.pageRows.map((row: any) => row.id),
        );
        const activeUsers =
          listType === 'inactive' || listType === 'archive'
            ? []
            : filteredActiveUsersDetailed
                .filter((item) => pageIdSet.has(item.raw.id))
                .map((item) =>
                  UserDbController.formatProductionUser(
                    item.raw,
                    productionPendingByEmail.get(
                      UserDbController.normalizeEmail(item.raw.email) || '',
                    ),
                    {
                      includePendingApprovalCount,
                      pendingApprovalCount:
                        pendingApprovalEligibleUsers.get(item.raw.id)?.count ||
                        0,
                    },
                  ),
                );
        const inactiveUsers =
          listType === 'inactive'
            ? filteredInactiveUsersDetailed
                .filter((item) => pageIdSet.has(item.raw.id))
                .map((item) =>
                  UserDbController.formatProductionUser(
                    item.raw,
                    productionPendingByEmail.get(
                      UserDbController.normalizeEmail(item.raw.email) || '',
                    ),
                    {
                      includePendingApprovalCount,
                      pendingApprovalCount:
                        pendingApprovalEligibleUsers.get(item.raw.id)?.count ||
                        0,
                    },
                  ),
                )
            : [];
        const archiveUsers =
          listType === 'archive'
            ? filteredArchiveUsersDetailed
                .filter((item) => pageIdSet.has(item.raw.id))
                .map((item) =>
                  UserDbController.formatProductionUser(
                    item.raw,
                    productionPendingByEmail.get(
                      UserDbController.normalizeEmail(item.raw.email) || '',
                    ),
                    {
                      includePendingApprovalCount,
                      pendingApprovalCount:
                        pendingApprovalEligibleUsers.get(item.raw.id)?.count ||
                        0,
                    },
                  ),
                )
            : [];
        const pendingUsers =
          listType === 'pending'
            ? filteredPendingUsersDetailed
                .filter((item: any) => pageIdSet.has(item.raw.id))
                .map((item: any) => item.detail)
            : [];

        return res.status(200).json({
          message: 'Users fetched successfully!',
          code: 200,
          data: {
            activeUsers,
            pendingUsers,
            inactiveUsers,
            archiveUsers,
          },
          activeCount,
          inactiveCount,
          archiveCount,
          pendingCount,
          limit,
          offset,
          pageInfo: selectedPage.pageInfo,
        });
      }

      const [activeCount, inactiveCount, archiveCount] =
        await prisma.$transaction([
          prisma.user.count({ where: buildUserWhere('ACTIVE') }),
          prisma.user.count({ where: buildUserWhere('INACTIVE') }),
          prisma.user.count({ where: buildUserWhere('ARCHIVE') }),
        ]);
      const activeWhere = buildUserWhere('ACTIVE');
      const inactiveWhere = buildUserWhere('INACTIVE');
      const archiveWhere = buildUserWhere('ARCHIVE');
      const isProductionStatusType =
        listType === 'active' ||
        listType === 'inactive' ||
        listType === 'archive';
      const selectedUserWhere =
        listType === 'inactive'
          ? inactiveWhere
          : listType === 'archive'
            ? archiveWhere
            : activeWhere;
      const selectedUserPageWhere =
        isProductionStatusType && cursor
          ? UserDbController.appendCursorWhere(
              selectedUserWhere,
              cursor,
              effectiveDirection === 'prev' ? 'newer' : 'older',
              'updatedAt',
            )
          : selectedUserWhere;
      const selectedUserNewWhere =
        isProductionStatusType && topCursor
          ? UserDbController.appendCursorWhere(
              selectedUserWhere,
              topCursor,
              'newer',
              'updatedAt',
            )
          : null;

      const [selectedRows, inactiveRows, pendingResult, selectedNewCount] =
        await Promise.all([
          listType === 'pending'
            ? Promise.resolve([])
            : prisma.user.findMany({
                where: selectedUserPageWhere,
                include: userInclude,
                orderBy: UserDbController.getPageOrder(
                  effectiveDirection,
                  'updatedAt',
                ),
                ...(isProductionStatusType
                  ? { skip: cursor ? 0 : offset, take: limit + 1 }
                  : {}),
              }),
          listType
            ? Promise.resolve([])
            : prisma.user.findMany({
                where: buildUserWhere('INACTIVE'),
                include: userInclude,
                orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
              }),
          listType === 'active' || listType === 'archive'
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

      const selectedPage = isProductionStatusType
        ? UserDbController.buildPageInfo(
            selectedRows,
            limit,
            requestedTopCursor,
            selectedNewCount,
            effectiveDirection,
            cursor,
            page,
            isPagePagination,
            'updatedAt',
          )
        : { pageRows: selectedRows, pageInfo: null };
      const firstActivePageRow = selectedPage.pageRows[0];
      if (
        isProductionStatusType &&
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
            'updatedAt',
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
      const activeVisiblePendingRequestIds = new Set(
        await UserDbController.getCurrentApproverRequestIds(
          'user_onboarding',
          userId,
          resolvedCompanyId,
        ),
      );
      const activeEffectivePendingIds =
        await UserDbController.filterEffectivelyPendingRequestIds(
          'user_onboarding',
          activePendingCandidates.map((request: any) => request.id),
        );
      const activePendingRequests = activePendingCandidates.filter(
        (request: any) =>
          activeEffectivePendingIds.has(request.id) &&
          UserDbController.isPendingUserRequestVisible({
            onboarding: request,
            isGlobal,
            visibleNodePaths: allVisibleNodePaths,
            viewerUserId: userId,
            visibleRequestIds: activeVisiblePendingRequestIds,
          }),
      );
      const productionPendingByEmail =
        await UserDbController.getEffectivePendingUserRequestsByEmail(
          resolvedCompanyId,
          [
            ...selectedPage.pageRows.map((user: any) => user.email),
            ...inactiveRows.map((user: any) => user.email),
          ],
        );
      const includePendingApprovalCount = false;
      const pendingApprovalEligibleUsers = includePendingApprovalCount
        ? await UserDbController.getPendingApprovalEligibleUserCounts(
            resolvedCompanyId,
            null,
          )
        : new Map<string, PendingApprovalEligibleUserSummary>();
      const selectedUsers = selectedPage.pageRows.map((user: any) =>
        UserDbController.formatProductionUser(
          user,
          productionPendingByEmail.get((user.email || '').toLowerCase()),
          {
            includePendingApprovalCount,
            pendingApprovalCount:
              pendingApprovalEligibleUsers.get(user.id)?.count || 0,
          },
        ),
      );
      const activeUsers =
        listType === 'inactive' || listType === 'archive' ? [] : selectedUsers;
      const inactiveUsers =
        listType === 'inactive'
          ? selectedUsers
          : inactiveRows.map((user: any) =>
              UserDbController.formatProductionUser(
                user,
                productionPendingByEmail.get((user.email || '').toLowerCase()),
                {
                  includePendingApprovalCount,
                  pendingApprovalCount:
                    pendingApprovalEligibleUsers.get(user.id)?.count || 0,
                },
              ),
            );
      const archiveUsers = listType === 'archive' ? selectedUsers : [];
      const pendingUsers = await UserDbController.formatPendingUsers(
        pendingResult.pendingOnboardings,
        resolvedCompanyId,
        { detail: true },
      );
      const fetchedPendingCount =
        listType === 'active' || listType === 'archive'
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
      const pendingCount =
        listType === 'active' || listType === 'archive'
          ? Math.max(fetchedPendingCount, activePendingRequests.length)
          : fetchedPendingCount;

      res.status(200).json({
        message: 'Users fetched successfully!',
        code: 200,
        data: {
          activeUsers,
          pendingUsers,
          inactiveUsers,
          archiveUsers,
        },
        activeCount,
        inactiveCount,
        archiveCount,
        pendingCount,
        limit,
        offset,
        pageInfo: isProductionStatusType
          ? selectedPage.pageInfo
          : (pendingResult as any).pageInfo || null,
      });
    } catch (error) {
      next(error);
    }
  }

  static async fetchUserDetails(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { companyCode, companyId, userId, id, reportee } = req.body;
      const email = UserDbController.normalizeFilterText(req.body?.email);

      if (!id && !email) {
        throw new AppError('id or email is required', 400);
      }

      let resolvedCompanyId = companyId;
      if (!resolvedCompanyId) {
        if (!companyCode) {
          throw new AppError('Company code or companyId is required', 400);
        }
        const company = await prisma.company.findUnique({
          where: { companyCode },
          select: { id: true },
        });
        if (!company) throw new AppError('Company not found', 404);
        resolvedCompanyId = company.id;
      }

      const viewerScope = await UserDbController.getFetchUserViewerScope(
        userId,
        resolvedCompanyId,
      );
      const isGlobal = viewerScope.isGlobal;
      const visibleNodeIds = viewerScope.visibleNodeIds;
      const visibleNodePaths = viewerScope.visibleNodePaths;
      const excludeSaasAdminsForViewer =
        viewerScope.isCorpAdmin && !viewerScope.isSaasAdmin;
      const excludeCorpAdminsForViewer =
        !viewerScope.isCorpAdmin && !viewerScope.isSaasAdmin;
      let canViewAsReporteeManager = false;

      if (id) {
        const pendingOnboarding = await prisma.userOnboarding.findFirst({
          where: {
            id,
            companyId: resolvedCompanyId,
            status: 'PENDING',
          },
        });
        if (!pendingOnboarding) {
          throw new AppError('User request not found', 404);
        }

        if (!isGlobal) {
          const visibleRequestIds = new Set(
            await UserDbController.getCurrentApproverRequestIds(
              'user_onboarding',
              userId,
              resolvedCompanyId,
            ),
          );

          let canViewPendingRequest =
            UserDbController.isPendingUserRequestVisible({
              onboarding: pendingOnboarding,
              isGlobal,
              visibleNodePaths,
              viewerUserId: userId,
              visibleRequestIds,
            });

          if (!canViewPendingRequest) {
            throw new AppError('User request not found', 404);
          }
        }

        const [detail] = await UserDbController.formatPendingUsers(
          [pendingOnboarding],
          resolvedCompanyId,
          { detail: true },
        );

        return res.status(200).json({
          message: 'User details fetched successfully!',
          code: 200,
          data: detail,
        });
      }

      if (!email) {
        throw new AppError('email is required', 400);
      }

      if (reportee === true && userId) {
        const reporteeMapping = await prisma.userMapping.findFirst({
          where: {
            companyId: resolvedCompanyId,
            reportingManager: userId,
            status: 'ACTIVE',
            user: {
              email: {
                equals: email,
                mode: 'insensitive',
              },
            },
          },
          select: { id: true },
        });

        canViewAsReporteeManager = Boolean(reporteeMapping);
      }

      const visibilityWhere = canViewAsReporteeManager
        ? {}
        : isGlobal
          ? excludeSaasAdminsForViewer
            ? {
                userAccesses: {
                  none: {
                    companyId: resolvedCompanyId,
                    roleCode: 'SAAS_ADMIN',
                  },
                },
              }
            : excludeCorpAdminsForViewer
              ? {
                  userAccesses: {
                    none: {
                      companyId: resolvedCompanyId,
                      roleCode: 'CORP_ADMIN',
                    },
                  },
                }
              : {}
          : {
              AND: [
                {
                  userAccesses: {
                    some: {
                      companyId: resolvedCompanyId,
                      nodeId: { in: visibleNodeIds },
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
                ...(excludeSaasAdminsForViewer
                  ? [
                      {
                        userAccesses: {
                          none: {
                            companyId: resolvedCompanyId,
                            roleCode: 'SAAS_ADMIN',
                          },
                        },
                      },
                    ]
                  : []),
                ...(excludeCorpAdminsForViewer
                  ? [
                      {
                        userAccesses: {
                          none: {
                            companyId: resolvedCompanyId,
                            roleCode: 'CORP_ADMIN',
                          },
                        },
                      },
                    ]
                  : []),
              ],
            };

      const user = await prisma.user.findFirst({
        where: {
          email: { equals: email, mode: 'insensitive' },
          userMappings: {
            some: {
              companyId: resolvedCompanyId,
            },
          },
          ...visibilityWhere,
        },
        include: {
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
        },
      });

      if (!user) {
        throw new AppError('User not found', 404);
      }

      const pendingByEmail =
        await UserDbController.getEffectivePendingUserRequestsByEmail(
          resolvedCompanyId,
          [user.email],
        );
      const pendingTagRequest = pendingByEmail.get(
        UserDbController.normalizeEmail(user.email),
      );
      const pendingApprovalEligibleUserCounts =
        await UserDbController.getPendingApprovalEligibleUserCounts(
          resolvedCompanyId,
          null,
        );

      res.status(200).json({
        message: 'User details fetched successfully!',
        code: 200,
        data: UserDbController.formatProductionUser(user, pendingTagRequest, {
          detail: true,
          pendingApprovalCount:
            pendingApprovalEligibleUserCounts.get(user.id)?.count || 0,
        }),
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

    const current = await UserDbController.fetchUserSnapshot(
      prisma as any,
      target.id,
      companyId,
    );

    if (initiatorId === target.id) {
      const reportingManagerUserIds =
        await UserDbController.getReportingManagerUserIds(
          companyId,
          target.id,
          current.snapshot.basicDetails.reportingManager,
        );
      await UserDbController.notifyConflict(
        companyId,
        initiatorId,
        'Users cannot modify, inactivate, archive, or reactivate their own record',
        UserDbController.formatUserReferenceName(current.user),
        [],
        reportingManagerUserIds,
      );
      throw UserDbController.buildNotificationHandledError(
        'Users cannot modify, inactivate, archive, or reactivate their own record',
        403,
      );
    }

    const adminAccess = await prisma.userAccess.findFirst({
      where: {
        userId: target.id,
        companyId,
        OR: [{ roleCode: 'SAAS_ADMIN' }, { roleCode: 'CORP_ADMIN' }],
      },
    });

    if (adminAccess) {
      throw new AppError(
        'SAAS Admin and Corp Admin users cannot be modified',
        400,
      );
    }

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
          excludedUserIds: [target.id],
          reqId: request.id,
          reqTable: 'user_onboarding',
        },
      );
      notificationRecipients = workflow.currentLevelApprovers;
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
    const modificationNotification =
      UserDbController.getUserNotificationContent(
        type,
        'initiated',
        userReferenceName,
      );
    const corpAdminUserIds =
      await NotificationService.getCorpAdminUserIds(companyId);
    const initiatorReportingManagerUserIds =
      await NotificationService.getReportingManagerUserIds(
        companyId,
        initiatorId,
      );
    const targetNotificationUserIds =
      await UserDbController.getCompanyMappedUserNotificationRecipientIds(
        companyId,
        { userId: target.id },
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
        targetNotificationUserIds,
        initiatorReportingManagerUserIds,
        corpAdminUserIds,
      ),
      requiredRecipientUserIds: NotificationService.mergeRecipientUserIds(
        notificationRecipients,
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

  private static async applyApprovedUserModification(
    tx: any,
    onboarding: any,
    eventUserId: string,
  ) {
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

    await NotificationService.syncNotificationSettingsForUserAccess(tx, {
      companyId: onboarding.companyId,
      userId: targetUserId,
      eventUserId,
      createReason: 'Default notification setting created because access was granted.',
      removeReason:
        onboarding.type === 'ARCHIVE'
          ? 'Notification setting removed because user was archived.'
          : onboarding.type === 'INACTIVE'
            ? 'Notification setting removed because user was inactivated.'
            : 'Notification setting removed because access was removed.',
    });
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
          const targetEmail =
            req.body?.targetEmail || req.body?.targetUserEmail;
          if (
            !(error as any)?.skipConflictNotification &&
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
        type: _type,
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
            .filter(
              (value: any): value is string =>
                typeof value === 'string' && value.trim().length > 0,
            ),
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
            currentLevelApprovers,
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
          notificationRecipients = currentLevelApprovers;

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
      const initiatorReportingManagerUserIds =
        await NotificationService.getReportingManagerUserIds(
          resolvedCompanyId,
          initiatorId,
        );
      await NotificationService.createRequestNotification({
        companyId: resolvedCompanyId,
        type: 'INITIATE',
        referenceType: 'USER',
        referenceId: onboarding.id,
        referenceName: userReferenceName,
        createdBy: initiatorId,
        recipientUserIds: NotificationService.mergeRecipientUserIds(
          notificationRecipients,
          initiatorReportingManagerUserIds,
          await NotificationService.getCorpAdminUserIds(resolvedCompanyId),
        ),
        requiredRecipientUserIds: NotificationService.mergeRecipientUserIds(
          notificationRecipients,
        ),
        includeCreatedBy: true,
        message: (() => {
          const summary = UserDbController.formatInitiatePermissionSummary(
            originalPermissions,
            expandedInitiatePermissions,
          );
          return summary
            ? `${
                UserDbController.getUserNotificationContent(
                  'INITIATE',
                  'initiated',
                  userReferenceName,
                ).message
              } with ${summary}`
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
        !(error as any)?.skipConflictNotification &&
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
      const rawRequestData = (onboarding.data as any) || {};
      const targetNotificationLookupEmail =
        rawRequestData?.targetUserEmail ||
        rawRequestData?.basicDetails?.email ||
        null;
      const targetNotificationUserIds =
        onboarding.type && onboarding.type !== 'INITIATE'
          ? await UserDbController.getCompanyMappedUserNotificationRecipientIds(
              onboarding.companyId,
              { email: targetNotificationLookupEmail },
            )
          : [];
      if (onboarding.type && onboarding.type !== 'INITIATE') {
        const targetUser = targetNotificationLookupEmail
          ? await prisma.user.findUnique({
              where: { email: targetNotificationLookupEmail },
              select: { id: true, name: true, email: true },
            })
          : null;
        if (targetUser?.id && targetUser.id === approverId) {
          const reportingManagerUserIds =
            await UserDbController.getReportingManagerUserIds(
              onboarding.companyId,
              targetUser.id,
            );
          await UserDbController.notifyConflict(
            onboarding.companyId,
            approverId,
            'Users cannot approve their own modification request',
            UserDbController.formatUserReferenceName(targetUser),
            [],
            reportingManagerUserIds,
          );
          throw new AppError(
            'Target user cannot approve their own modification request',
            403,
          );
        }
      }

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
        const reportingManagerUserIds =
          onboarding.type && onboarding.type !== 'INITIATE'
            ? await UserDbController.getReportingManagerUserIds(
                onboarding.companyId,
                approverId,
              )
            : [];
        await UserDbController.notifyConflict(
          onboarding.companyId,
          approverId,
          'Users cannot approve their own request',
          UserDbController.formatUserReferenceName(
            {
              name: rawRequestData?.basicDetails?.name || null,
              email:
                rawRequestData?.targetUserEmail ||
                rawRequestData?.basicDetails?.email ||
                null,
            },
            'user',
          ),
          [],
          reportingManagerUserIds,
        );
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

      const requestData = rawRequestData;
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
              approverId,
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

          await NotificationService.syncNotificationSettingsForUserAccess(tx, {
            companyId: company.id,
            userId: user.id,
            eventUserId: approverId,
            createReason:
              'Default notification setting created because access was granted.',
            removeReason:
              'Notification setting removed because access was removed.',
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
      const isPartialApproval = result?.status === 'PARTIAL_APPROVED';

      const requestInitiatorId =
        await NotificationService.getRequestInitiatorId(id, 'user_onboarding');
      const requestInitiatorReportingManagerUserIds =
        await NotificationService.getRequestInitiatorReportingManagerIds(
          onboarding.companyId,
          id,
          'user_onboarding',
        );
      const notificationRecipientUserIds =
        isPartialApproval
          ? NotificationService.mergeRecipientUserIds(notificationRecipients)
          : NotificationService.mergeRecipientUserIds(
              notificationRecipients,
              requestInitiatorId,
              requestInitiatorReportingManagerUserIds,
            );
      const corpAdminUserIds = await NotificationService.getCorpAdminUserIds(
        onboarding.companyId,
      );
      const notificationLookupEmail =
        result?.status === 'REJECTED' ? historyEmail : email || historyEmail;
      const companySaasAdminUserIds =
        await UserDbController.getCompanySaasAdminUserIds(onboarding.companyId);
      const allEligibleApproverUserIds = Array.isArray(
        onboarding.eligibleApprovers,
      )
        ? onboarding.eligibleApprovers
        : [];
      const notificationUser = notificationLookupEmail
        ? await prisma.user.findUnique({
            where: { email: notificationLookupEmail },
            select: { name: true, email: true },
          })
        : null;
      const notificationReferenceName =
        UserDbController.formatUserReferenceName({
          name: name || notificationUser?.name,
          email: notificationLookupEmail || notificationUser?.email,
        });
      const userNotificationContent =
        isPartialApproval
          ? UserDbController.getUserPendingApprovalNotificationContent(
              requestType,
              notificationReferenceName,
            )
          : requestType !== 'INITIATE' && result?.status
          ? UserDbController.getUserNotificationContent(
              requestType,
              result.status === 'REJECTED' ? 'rejected' : 'approved',
              notificationReferenceName,
            )
          : null;
      const affectedNodeRecipientUserIds =
        result?.status === 'APPROVED'
          ? await UserDbController.getNodeAccessNotificationRecipientIds(
              onboarding.companyId,
              UserDbController.extractUserNotificationNodePaths(
                onboarding.data,
              ),
            )
          : [];
      const onboardedUserRecipientIds =
        requestType === 'INITIATE' && result?.status === 'APPROVED'
          ? await UserDbController.getCompanyMappedUserNotificationRecipientIds(
              onboarding.companyId,
              { email: notificationLookupEmail },
            )
          : [];

      if (isPartialApproval) {
        const levelApprovalNotificationContent =
          UserDbController.getUserLevelApprovalNotificationContent(
            requestType,
            notificationReferenceName,
            result?.level ?? null,
          );

        await NotificationService.createRequestNotification({
          companyId: onboarding.companyId,
          type: UserDbController.getUserNotificationType(
            onboarding.type,
            result?.status,
          ),
          ...levelApprovalNotificationContent,
          referenceType: 'USER',
          referenceId: id,
          referenceName: notificationReferenceName,
          createdBy: approverId,
          recipientUserIds: NotificationService.mergeRecipientUserIds(
            allEligibleApproverUserIds,
            requestInitiatorId,
            corpAdminUserIds,
            companySaasAdminUserIds,
          ),
          requiredRecipientUserIds: NotificationService.mergeRecipientUserIds(
            allEligibleApproverUserIds,
            requestInitiatorId,
            corpAdminUserIds,
            companySaasAdminUserIds,
          ),
          includeCreatedBy: true,
          isPending: false,
        });
      }

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
          ...(isPartialApproval
            ? []
            : [
                targetNotificationUserIds,
                affectedNodeRecipientUserIds,
                onboardedUserRecipientIds,
                corpAdminUserIds,
              ]),
        ),
        requiredRecipientUserIds: isPartialApproval
          ? NotificationService.mergeRecipientUserIds(notificationRecipients)
          : NotificationService.mergeRecipientUserIds(
              requestInitiatorId,
              approverId,
            ),
        includeCreatedBy: true,
        isPending: isPartialApproval,
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

      const rawHistory = await prisma.userHistory.findMany({
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
        new Set(rawHistory.map((h) => h.reqId).filter(Boolean)),
      ) as string[];

      const [workflowApprovers, requestSnapshots] = await Promise.all([
        prisma.workflowApprover.findMany({
          where: { reqId: { in: reqIds } },
          orderBy: { level: 'asc' },
        }),
        reqIds.length > 0
          ? prisma.userOnboarding.findMany({
              where: { id: { in: reqIds } },
              select: {
                id: true,
                data: true,
                oldData: true,
                type: true,
                impact: true,
                initiatorId: true,
                status: true,
                eligibleApprovers: true,
              },
            })
          : Promise.resolve([]),
      ]);
      const requestSnapshotMap = new Map(
        requestSnapshots.map((request) => [request.id, request]),
      );
      const targetEmails = Array.from(
        new Set(
          requestSnapshots
            .filter((request) => request.type && request.type !== 'INITIATE')
            .map((request) => {
              const data = request.data as any;
              return data?.targetUserEmail || data?.basicDetails?.email || null;
            })
            .filter(
              (value): value is string =>
                typeof value === 'string' && value.trim().length > 0,
            ),
        ),
      );
      const targetUsers =
        targetEmails.length > 0
          ? await prisma.user.findMany({
              where: { email: { in: targetEmails } },
              select: { id: true, email: true },
            })
          : [];
      const targetUserIdByEmail = new Map(
        targetUsers.map((user) => [user.email, user.id]),
      );
      const targetUserIdByReqId = new Map<string, string>();
      requestSnapshots.forEach((request) => {
        if (!request.type || request.type === 'INITIATE') return;
        const data = request.data as any;
        const targetEmail =
          data?.targetUserEmail || data?.basicDetails?.email || null;
        const targetUserId =
          typeof targetEmail === 'string'
            ? targetUserIdByEmail.get(targetEmail)
            : null;
        if (targetUserId) {
          targetUserIdByReqId.set(request.id, targetUserId);
        }
      });

      const isGlobalViewer =
        !viewerUserId ||
        Boolean(
          await prisma.userAccess.findFirst({
            where: {
              userId: viewerUserId,
              companyId: resolvedCompanyId,
              isGlobalAccess: true,
            },
            select: { id: true },
          }),
        );
      const visiblePendingRequestIds = new Set(
        isGlobalViewer
          ? []
          : await UserDbController.getCurrentApproverRequestIds(
              'user_onboarding',
              viewerUserId,
              resolvedCompanyId,
            ),
      );
      const history = rawHistory.filter((entry) => {
        if (!entry.reqId) return true;
        const requestSnapshot = requestSnapshotMap.get(entry.reqId);
        if (!requestSnapshot) return true;

        const isPending =
          String(requestSnapshot.status || '').toUpperCase() === 'PENDING';

        // Only the current pending request snapshot is permission-gated.
        // Completed modification events must remain visible in the timeline.
        if (!isPending) {
          return true;
        }

        return UserDbController.isPendingUserRequestVisible({
          onboarding: requestSnapshot,
          isGlobal: isGlobalViewer,
          visibleNodePaths: [],
          viewerUserId,
          visibleRequestIds: visiblePendingRequestIds,
        });
      });

      // Group workflow levels by reqId
      const workflowMap = new Map<string, any[]>();
      workflowApprovers.forEach((wa) => {
        const existing = workflowMap.get(wa.reqId) || [];
        existing.push(wa);
        workflowMap.set(wa.reqId, existing);
      });

      // Build request-level maps used to filter displayed approvers.
      const initiatorMap = new Map<string, string>();
      const approvedUserMap = new Map<string, Set<string>>();
      history.forEach((h) => {
        if (h.reqId) {
          const requestSnapshot = requestSnapshotMap.get(h.reqId);
          if (requestSnapshot?.initiatorId && !initiatorMap.has(h.reqId)) {
            initiatorMap.set(h.reqId, requestSnapshot.initiatorId);
          }
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
        const initiatorId = initiatorMap.get(reqId) || null;
        const approvedUserIds = Array.from(
          approvedUserMap.get(reqId) ?? new Set<string>(),
        );
        const targetUserId = targetUserIdByReqId.get(reqId);
        if (targetUserId) {
          approvedUserIds.push(targetUserId);
        }
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
        ...history.map((h) => h.eventUserId),
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
      const eligibleApproverMap = new Map(
        approverDetails.map((u) => [
          u.id,
          {
            name: u.name || 'System',
            email: u.email || 'system@internal',
          },
        ]),
      );
      const historyUserMap = new Map(
        history.map((h) => [
          h.eventUserId,
          HistoryUserUtil.formatAuditUser(
            h.user,
            h.eventUserId,
            saasAdminUserIds,
            viewerUserId,
          ),
        ]),
      );
      const approvedEventsByReqLevel = new Map<string, any[]>();
      const rejectedEventByReqId = new Map<
        string,
        { level: number | null; createdAt: Date | null }
      >();
      history.forEach((h) => {
        if (h.reqId && h.event === 'APPROVED' && h.level) {
          const key = `${h.reqId}:${h.level}`;
          const existing = approvedEventsByReqLevel.get(key) || [];
          existing.push({
            historyId: h.id,
            user: historyUserMap.get(h.eventUserId),
            createdAt: h.createdAt,
          });
          approvedEventsByReqLevel.set(key, existing);
        }

        if (h.reqId && h.event === 'REJECTED') {
          const existing = rejectedEventByReqId.get(h.reqId);
          const eventTime = h.createdAt ? new Date(h.createdAt) : null;
          const existingTime = existing?.createdAt ?? null;

          if (
            !existing ||
            (eventTime &&
              (!existingTime || eventTime.getTime() > existingTime.getTime()))
          ) {
            rejectedEventByReqId.set(h.reqId, {
              level: h.level ?? null,
              createdAt: eventTime,
            });
          }
        }
      });
      const getMandatoryApprovalCount = (level: any) =>
        Math.max(Number(level?.mandatoryCount || 1), 1);
      const getLevelRule = (level: any) =>
        getMandatoryApprovalCount(level) > 1 ? 'AND' : null;
      const toUserSummary = (user: any) =>
        user ? { name: user.name, email: user.email } : null;
      const getSortedApprovedEvents = (
        reqId: string,
        level: number,
        direction: 'asc' | 'desc' = 'asc',
      ) => {
        const sortedEvents = [
          ...(approvedEventsByReqLevel.get(`${reqId}:${level}`) || []),
        ].sort((left: any, right: any) => {
          const leftTime = left.createdAt
            ? new Date(left.createdAt).getTime()
            : 0;
          const rightTime = right.createdAt
            ? new Date(right.createdAt).getTime()
            : 0;
          if (leftTime !== rightTime) {
            return leftTime - rightTime;
          }
          return String(left.historyId).localeCompare(String(right.historyId));
        });
        return direction === 'desc' ? sortedEvents.reverse() : sortedEvents;
      };
      const approvalStepMetaByReqId = new Map<
        string,
        {
          levelStartByLevel: Map<number, number>;
          totalApprovalSteps: number;
        }
      >();
      const approvedEventStepByHistoryId = new Map<string, number>();
      for (const [reqId, levels] of workflowMap.entries()) {
        const sortedLevels = [...levels].sort(
          (left: any, right: any) => left.level - right.level,
        );
        const levelStartByLevel = new Map<number, number>();
        let nextStep = 1;
        sortedLevels.forEach((level: any) => {
          levelStartByLevel.set(level.level, nextStep);
          getSortedApprovedEvents(reqId, level.level).forEach(
            (event: any, index: number) => {
              approvedEventStepByHistoryId.set(event.historyId, nextStep + index);
            },
          );
          nextStep += getMandatoryApprovalCount(level);
        });
        approvalStepMetaByReqId.set(reqId, {
          levelStartByLevel,
          totalApprovalSteps: nextStep - 1,
        });
      }
      const getLevelStartStep = (reqId: string, level: number) =>
        approvalStepMetaByReqId.get(reqId)?.levelStartByLevel.get(level) ?? null;
      const getApprovedEventStep = (
        reqId: string,
        level: number,
        historyId?: string | null,
      ) => {
        if (historyId) {
          const directStep = approvedEventStepByHistoryId.get(historyId);
          if (directStep) return directStep;
        }
        const startStep = getLevelStartStep(reqId, level);
        if (!startStep) return null;
        const approvedCount = getSortedApprovedEvents(reqId, level).length;
        return approvedCount > 0 ? startStep + approvedCount - 1 : startStep;
      };
      const getNextPendingApprovalStep = (reqId: string, level: number) => {
        const startStep = getLevelStartStep(reqId, level);
        if (!startStep) return null;
        return startStep + getSortedApprovedEvents(reqId, level).length;
      };
      const getRejectedApprovalStep = (reqId: string, level: number) => {
        const startStep = getLevelStartStep(reqId, level);
        if (!startStep) return null;
        const approvedCount = getSortedApprovedEvents(reqId, level).length;
        return startStep + approvedCount;
      };
      const toApprovedUserSummary = (
        event: any,
        approvalStep: number | null,
      ) =>
        event?.user
          ? {
              levelCount: `A${approvalStep || 1}`,
              name: event.user.name,
              email: event.user.email,
              approvedAt: event.createdAt,
            }
          : null;
      const getLevelApprovalCount = (reqId: string, level: number) =>
        getSortedApprovedEvents(reqId, level).length;
      const isLevelApproved = (reqId: string, level: any) =>
        getLevelApprovalCount(reqId, level.level) >=
        getMandatoryApprovalCount(level);
      const buildApprovalSummary = (reqId: string) => {
        const levels = workflowMap.get(reqId) || [];
        const requestStatus = requestSnapshotMap.get(reqId)?.status || null;
        const normalizedRequestStatus = String(
          requestStatus || '',
        ).toUpperCase();

        if (levels.length === 0) {
          return {
            ...UserDbController.getEmptyUserHistoryApprovalSummary(),
            currentStatus:
              normalizedRequestStatus === 'APPROVED' ||
              normalizedRequestStatus === 'REJECTED' ||
              normalizedRequestStatus === 'PENDING'
                ? normalizedRequestStatus
                : null,
          };
        }

        const rejectedLevel = rejectedEventByReqId.get(reqId)?.level ?? null;
        const completedLevels = levels.filter((level: any) =>
          isLevelApproved(reqId, level),
        ).length;
        const currentPendingLevel =
          normalizedRequestStatus === 'PENDING'
            ? (levels.find((level: any) => !isLevelApproved(reqId, level))
                ?.level ?? null)
            : null;
        const currentPendingStep =
          currentPendingLevel && normalizedRequestStatus === 'PENDING'
            ? getNextPendingApprovalStep(reqId, currentPendingLevel)
            : null;
        const isRejected = normalizedRequestStatus === 'REJECTED';
        const allApproved =
          levels.length > 0 && completedLevels === levels.length;

        return {
          currentStatus: isRejected
            ? 'REJECTED'
            : allApproved || requestStatus === 'APPROVED'
              ? 'APPROVED'
              : 'PENDING',
          totalLevels: levels.length,
          completedLevels,
          ...(rejectedLevel ? { rejectedAtLevel: rejectedLevel } : {}),
          ...(currentPendingLevel ? { currentPendingLevel } : {}),
          ...(currentPendingStep ? { currentPendingStep } : {}),
        };
      };
      const buildApprovedBy = (reqId: string) =>
        (workflowMap.get(reqId) || [])
          .map((level: any) => {
            const rule = getLevelRule(level);
            const approvers = getSortedApprovedEvents(reqId, level.level)
              .map((event) =>
                toApprovedUserSummary(
                  event,
                  getApprovedEventStep(reqId, level.level, event.historyId),
                ),
              )
              .filter(Boolean);
            return approvers.length > 0
              ? {
                  level: level.level,
                  rule,
                  approvedBy: approvers,
                }
              : null;
          })
          .filter(Boolean)
          .sort((left: any, right: any) => right.level - left.level);

      // Build eligible approvers for pending levels
      const buildEligibleApprovers = (reqId: string) => {
        const levels = workflowMap.get(reqId) || [];
        const pendingLevel = levels.find((l: any) => l.status === 'PENDING');
        if (!pendingLevel) return [];
        const approverIds = Array.isArray(pendingLevel.approversList)
          ? (pendingLevel.approversList as string[])
          : [];
        return approverIds
          .map((id: string) => {
            const user = eligibleApproverMap.get(id);
            return user ? { name: user.name, email: user.email } : null;
          })
          .filter(Boolean);
      };

      const modificationSequenceByReqId = new Map<string, number>();
      const historyByReqId = new Map<string, any[]>();
      history
        .filter((history) => history.reqId)
        .sort((left, right) => {
          const leftTime = left.createdAt
            ? new Date(left.createdAt).getTime()
            : 0;
          const rightTime = right.createdAt
            ? new Date(right.createdAt).getTime()
            : 0;
          if (leftTime !== rightTime) return leftTime - rightTime;
          return String(left.id).localeCompare(String(right.id));
        })
        .forEach((entry) => {
          if (entry.reqId) {
            const existingEntries = historyByReqId.get(entry.reqId) || [];
            existingEntries.push(entry);
            historyByReqId.set(entry.reqId, existingEntries);
          }
          const requestType = entry.reqId
            ? UserDbController.resolveUserHistoryRequestType(
                requestSnapshotMap.get(entry.reqId),
              )
            : 'INITIATE';
          if (
            entry.event === 'INITIATE' &&
            UserDbController.isUserModificationHistoryType(requestType) &&
            entry.reqId &&
            !modificationSequenceByReqId.has(entry.reqId)
          ) {
            modificationSequenceByReqId.set(
              entry.reqId,
              modificationSequenceByReqId.size + 1,
            );
          }
        });

      // 3. Add actual history entries
      const formattedHistory = history.map((h) => {
        const requestType = h.reqId
          ? UserDbController.resolveUserHistoryRequestType(
              requestSnapshotMap.get(h.reqId),
            )
          : null;
        const changeCount = h.reqId
          ? UserDbController.getUserHistoryChangeCount(
              requestSnapshotMap.get(h.reqId)?.data,
              requestSnapshotMap.get(h.reqId)?.oldData,
              requestType,
            )
          : { added: 0, modify: 0, remove: 0 };
        const isChangeRequestStart =
          h.event === 'INITIATE' &&
          UserDbController.isUserModificationHistoryType(requestType);
        const displayEvent = UserDbController.getUserHistoryDisplayEvent(
          h.event,
          requestType,
        );
        const approvalSummary = h.reqId
          ? buildApprovalSummary(h.reqId)
          : UserDbController.getEmptyUserHistoryApprovalSummary();
        const approvalLevel =
          displayEvent === 'APPROVED' || displayEvent === 'REJECTED'
            ? (h.level ?? null)
            : approvalSummary.currentStatus === 'PENDING'
              ? ((approvalSummary as any).currentPendingLevel ?? null)
              : null;
        const approvalStep =
          displayEvent === 'APPROVED' && h.reqId && h.level
            ? getApprovedEventStep(h.reqId, h.level, h.id)
            : displayEvent === 'REJECTED' && h.reqId && h.level
              ? getRejectedApprovalStep(h.reqId, h.level)
              : approvalSummary.currentStatus === 'PENDING'
                ? ((approvalSummary as any).currentPendingStep ?? null)
                : null;
        const levelCount = UserDbController.getUserHistoryLevelCount(
          displayEvent || '',
          {
            approvalLevel,
            approvalStep,
            isChangeRequestStart,
            modificationSequence: h.reqId
              ? modificationSequenceByReqId.get(h.reqId) || 1
              : null,
          },
        );
        const eventUser =
          h.reqId && h.event === 'INITIATE' && initiatorMap.get(h.reqId)
            ? historyUserMap.get(initiatorMap.get(h.reqId) as string) ||
              HistoryUserUtil.formatAuditUser(
                h.user,
                h.eventUserId,
                saasAdminUserIds,
                viewerUserId,
              )
            : HistoryUserUtil.formatAuditUser(
                h.user,
                h.eventUserId,
                saasAdminUserIds,
                viewerUserId,
              );
        const approvedBy = h.reqId ? buildApprovedBy(h.reqId) : [];

        const result: Record<string, any> = {
          id: h.id,
          email: h.email,
          type: requestType,
          impact: h.reqId
            ? requestSnapshotMap.get(h.reqId)?.impact || null
            : null,
          companyCode: h.company.companyCode,
          oldData: h.reqId
            ? requestSnapshotMap.get(h.reqId)?.oldData ||
              ((requestSnapshotMap.get(h.reqId)?.data as any)?.oldData ?? null)
            : null,
          newData: h.reqId
            ? requestSnapshotMap.get(h.reqId)?.data || null
            : null,
          event: displayEvent,
          levelCount,
          createdAt: h.createdAt,
          remarks: h.remarks,
          user: eventUser,
          changeCount,
          approvalLevel,
          _reqId: h.reqId || null,
        };

        // APPROVED: include level, approvalSummary, approvedBy
        if (displayEvent === 'APPROVED' && approvalLevel != null) {
          result.level = approvalLevel;
          const summary: Record<string, any> = {
            currentStatus: approvalSummary.currentStatus,
            totalLevels: approvalSummary.totalLevels,
            completedLevels: approvalSummary.completedLevels,
          };
          result.approvalSummary = summary;
          if (approvedBy.length > 0) {
            result.approvedBy = approvedBy;
          }
        }

        // REJECTED: include level only (approvalSummary/approvedBy go in APPROVAL_PROGRESS)
        if (displayEvent === 'REJECTED' && approvalLevel != null) {
          result.level = approvalLevel;
        }

        // INITIATE, MODIFY, ACTIVE, INACTIVE, ARCHIVE: no extra fields

        return result;
      });

      // 4. Generate synthetic events and track which reqIds need APPROVED filtering
      const syntheticEvents: any[] = [];
      const processedReqIds = new Set<string>();
      // reqIds whose individual APPROVED events should be filtered from formattedHistory
      const suppressApprovedForReqIds = new Set<string>();

      for (const h of history) {
        if (!h.reqId || processedReqIds.has(h.reqId)) continue;
        processedReqIds.add(h.reqId);

        const approvalSummary = buildApprovalSummary(h.reqId);
        const approvedBy = buildApprovedBy(h.reqId);
        const changeCount = UserDbController.getUserHistoryChangeCount(
          requestSnapshotMap.get(h.reqId)?.data,
          requestSnapshotMap.get(h.reqId)?.oldData,
          UserDbController.resolveUserHistoryRequestType(
            requestSnapshotMap.get(h.reqId),
          ),
        );

        // Only generate synthetic events if there are approval levels
        if (approvalSummary.totalLevels === 0) continue;

        const isPending = approvalSummary.currentStatus === 'PENDING';
        const isRejected = approvalSummary.currentStatus === 'REJECTED';
        const isApproved = approvalSummary.currentStatus === 'APPROVED';
        const isMultiLevel = approvalSummary.totalLevels > 1;

        // Get the latest history event for this reqId to derive timestamps
        const latestEntries = historyByReqId.get(h.reqId) || [];
        const latestEvent = latestEntries[latestEntries.length - 1];
        const syntheticSource = latestEvent || h;

        // PENDING: suppress individual APPROVED events, they go in L{n} Pending Approval
        if (isPending) {
          suppressApprovedForReqIds.add(h.reqId);
        }

        // REJECTED: suppress individual APPROVED events, they go in APPROVAL_PROGRESS
        if (isRejected) {
          suppressApprovedForReqIds.add(h.reqId);
        }

        // APPROVED multi-level: suppress individual APPROVED events,
        // create consolidated APPROVED event
        if (isApproved && isMultiLevel) {
          suppressApprovedForReqIds.add(h.reqId);

          syntheticEvents.push({
            id: syntheticSource.id,
            email: syntheticSource.email,
            type: UserDbController.resolveUserHistoryRequestType(
              requestSnapshotMap.get(h.reqId),
            ),
            impact: requestSnapshotMap.get(h.reqId)?.impact || null,
            companyCode: syntheticSource.company.companyCode,
            oldData: null,
            newData: null,
            event: 'APPROVED',
            levelCount: `A${approvalStepMetaByReqId.get(h.reqId)?.totalApprovalSteps || approvalSummary.totalLevels}`,
            createdAt: latestEvent?.createdAt ?? null,
            remarks: null,
            user: HistoryUserUtil.formatAuditUser(
              syntheticSource.user,
              syntheticSource.eventUserId,
              saasAdminUserIds,
              viewerUserId,
            ),
            changeCount,
            approvalLevel: null,
            approvalSummary: {
              currentStatus: 'APPROVED',
              totalLevels: approvalSummary.totalLevels,
              completedLevels: approvalSummary.completedLevels,
            },
            approvedBy,
          });
        }

        // APPROVAL_PROGRESS: ONLY for REJECTED requests
        // Shows partial approval progress before the rejection happened
        if (isRejected && approvalSummary.completedLevels > 0) {
          const progressSummary: Record<string, any> = {
            currentStatus: approvalSummary.currentStatus,
            totalLevels: approvalSummary.totalLevels,
            completedLevels: approvalSummary.completedLevels,
          };
          if ((approvalSummary as any).rejectedAtLevel) {
            progressSummary.rejectedAtLevel = (
              approvalSummary as any
            ).rejectedAtLevel;
          }

          syntheticEvents.push({
            id: syntheticSource.id,
            email: syntheticSource.email,
            type: UserDbController.resolveUserHistoryRequestType(
              requestSnapshotMap.get(h.reqId),
            ),
            impact: requestSnapshotMap.get(h.reqId)?.impact || null,
            companyCode: syntheticSource.company.companyCode,
            oldData: null,
            newData: null,
            event: 'APPROVAL_PROGRESS',
            levelCount: null,
            createdAt: latestEvent?.createdAt
              ? new Date(
                  new Date(latestEvent.createdAt).getTime() - 1000,
                ).toISOString()
              : null,
            remarks: null,
            user: HistoryUserUtil.formatAuditUser(
              syntheticSource.user,
              syntheticSource.eventUserId,
              saasAdminUserIds,
              viewerUserId,
            ),
            changeCount,
            approvalLevel: null,
            approvalSummary: progressSummary,
            approvedBy,
          });
        }

        // L{n} Pending Approval: for PENDING requests
        if (isPending && (approvalSummary as any).currentPendingLevel) {
          const pendingLevel = (approvalSummary as any).currentPendingLevel;
          const pendingStep =
            (approvalSummary as any).currentPendingStep ?? pendingLevel;
          const eligibleApprovers = buildEligibleApprovers(h.reqId);

          syntheticEvents.push({
            id: syntheticSource.id,
            email: syntheticSource.email,
            type: UserDbController.resolveUserHistoryRequestType(
              requestSnapshotMap.get(h.reqId),
            ),
            impact: requestSnapshotMap.get(h.reqId)?.impact || null,
            companyCode: syntheticSource.company.companyCode,
            oldData: null,
            newData: null,
            event: `L${pendingLevel} Pending Approval`,
            levelCount: `A${pendingStep}`,
            createdAt: null,
            remarks: null,
            user: HistoryUserUtil.formatAuditUser(
              syntheticSource.user,
              syntheticSource.eventUserId,
              saasAdminUserIds,
              viewerUserId,
            ),
            changeCount,
            approvalLevel: null,
            approvalSummary: {
              currentStatus: 'PENDING',
              totalLevels: approvalSummary.totalLevels,
              completedLevels: approvalSummary.completedLevels,
            },
            ...(eligibleApprovers.length > 0
              ? { eligibleapprovers: eligibleApprovers }
              : {}),
            ...(approvedBy.length > 0 ? { approvedBy } : {}),
          });
        }
      }

      // 5. Filter out individual APPROVED events for reqIds that have synthetic events
      const filteredHistory = formattedHistory.filter((item: any) => {
        if (
          item.event === 'APPROVED' &&
          item._reqId &&
          suppressApprovedForReqIds.has(item._reqId)
        ) {
          return false;
        }
        return true;
      });

      // Sort LIFO: null createdAt (pending/consolidated) first, then newest to oldest
      const eventPriority = (event: string) => {
        if (event && event.includes('Pending Approval')) return 0;
        if (event === 'APPROVAL_PROGRESS') return 1;
        if (event === 'REJECTED') return 2;
        if (event === 'APPROVED') return 3;
        return 4;
      };

      const resultList = [...filteredHistory, ...syntheticEvents].sort(
        (left: any, right: any) => {
          // null createdAt always comes first (top)
          if (!left.createdAt && right.createdAt) return -1;
          if (left.createdAt && !right.createdAt) return 1;
          if (!left.createdAt && !right.createdAt) {
            return eventPriority(left.event) - eventPriority(right.event);
          }

          const leftTime = new Date(left.createdAt).getTime();
          const rightTime = new Date(right.createdAt).getTime();
          if (leftTime !== rightTime) return rightTime - leftTime;

          // Same timestamp: use event priority
          const leftPriority = eventPriority(left.event);
          const rightPriority = eventPriority(right.event);
          if (leftPriority !== rightPriority)
            return leftPriority - rightPriority;

          return String(right.id).localeCompare(String(left.id));
        },
      );

      const seenApprovedReqIds = new Set<string>();
      const dedupedResultList = resultList.filter((item: any) => {
        if (item.event !== 'APPROVED' || !item._reqId) return true;
        if (seenApprovedReqIds.has(item._reqId)) return false;
        seenApprovedReqIds.add(item._reqId);
        return true;
      });

      // Remove internal _reqId before sending response
      const cleanedResultList = dedupedResultList.map(
        ({ _reqId, ...rest }: any) => rest,
      );

      res.status(200).json({
        message: 'User history fetched successfully!',
        code: 200,
        data: cleanedResultList,
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
      if (
        onboarding &&
        String(onboarding.status || '').toUpperCase() === 'PENDING'
      ) {
        const isGlobalViewer =
          !viewerUserId ||
          Boolean(
            await prisma.userAccess.findFirst({
              where: {
                userId: viewerUserId,
                companyId: resolvedCompanyId,
                isGlobalAccess: true,
              },
              select: { id: true },
            }),
          );
        const visiblePendingRequestIds = new Set(
          isGlobalViewer
            ? []
            : await UserDbController.getCurrentApproverRequestIds(
                'user_onboarding',
                viewerUserId,
                resolvedCompanyId,
              ),
        );

        if (
          !UserDbController.isPendingUserRequestVisible({
            onboarding,
            isGlobal: isGlobalViewer,
            visibleNodePaths: [],
            viewerUserId,
            visibleRequestIds: visiblePendingRequestIds,
          })
        ) {
          throw new AppError('User history not found', 404);
        }
      }
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

      const fallbackSnapshot =
        UserDbController.extractUserSnapshot(requestData);
      if (!newData) {
        newData = fallbackSnapshot;
      }
      const responseOldData =
        await HistoryUserUtil.enrichUserHistoryOldData(oldData);
      const responseNewData = HistoryUserUtil.formatUserHistoryDetailNewData({
        requestData,
        requestOldData: onboarding?.oldData,
        resolvedOldData: oldData,
        resolvedNewData: newData,
        requestType,
      });
      const changeCount = UserDbController.getUserHistoryChangeCount(
        requestData,
        oldData,
        requestType,
      );

      const saasAdminUserIds = await HistoryUserUtil.getSaasAdminUserIds([
        viewerUserId,
        history.eventUserId,
      ]);

      const historyRequestType =
        UserDbController.resolveUserHistoryRequestType(onboarding);
      const displayEvent = UserDbController.getUserHistoryDisplayEvent(
        history.event,
        historyRequestType,
      );

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
          oldData: responseOldData,
          newData: responseNewData,
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
        const corpAdminUserIds =
          await NotificationService.getCorpAdminUserIds(resolvedCompanyId);
        const recipients = NotificationService.mergeRecipientUserIds(
          requestInitiatorId || initiatorId,
          requestApproverIds,
          corpAdminUserIds,
        );

        await NotificationService.createRequestNotification({
          companyId: resolvedCompanyId,
          type: 'MODIFICATION',
          name: 'User request failed',
          message: `User request failed: ${
            error instanceof Error ? error.message : 'Unexpected error'
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
      const { userId, companyId, subCategory, filter, applied } = req.body;
      const workflowSubCategory =
        UserDbController.normalizeFilterText(subCategory);

      if (filter === true && workflowSubCategory === 'USER_ACC') {
        const dropdowns = await UserDbController.buildUserAccFilterDropdowns(
          userId,
          companyId,
          applied,
        );

        return res.status(200).json({
          success: true,
          filter: true,
          subCategory: 'USER_ACC',
          dropdowns,
        });
      }

      if (filter === true && workflowSubCategory === 'WORK_FLOW') {
        const dropdowns = await UserDbController.buildWorkflowFilterDropdowns(
          userId,
          companyId,
          applied,
        );

        return res.status(200).json({
          ...dropdowns,
        });
      }

      const [
        pendingOrgNodePaths,
        pendingWorkflowKeys,
        pendingWorkflowOptionsByNodePath,
      ] = await Promise.all([
        UserDbController.getPendingOrgNodePathsForFetch(companyId),
        UserDbController.getPendingWorkflowKeysForFetch(companyId),
        UserDbController.getPendingWorkflowOptionsForFetch(
          companyId,
          workflowSubCategory,
        ),
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
              workflows: [
                ...node.workflows.filter(
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
                ...(pendingWorkflowOptionsByNodePath.get(node.nodePath) || []),
              ],
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

        return res.status(200).json(nodes);
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
            const nodeWithWorkflows =
              UserDbController.withDefaultWorkflowOption(
                {
                  ...ua.orgStructure,
                  workflows: [
                    ...ua.orgStructure.workflows.filter(
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
                    ...(pendingWorkflowOptionsByNodePath.get(
                      ua.orgStructure.nodePath,
                    ) || []),
                  ],
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

        return res.status(200).json(nodes);
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

      if (!companyId) {
        throw new AppError('Company id is required', 400);
      }

      const normalizedNodePath = String(nodePath).trim();
      const companyMappedUsers = await prisma.userMapping.findMany({
        where: {
          companyId,
          status: {
            in: ['ACTIVE', 'INACTIVE'],
          },
        },
        select: {
          userId: true,
        },
      });

      const mappedUserIds = Array.from(
        new Set(
          companyMappedUsers
            .map((mapping) => String(mapping.userId || '').trim())
            .filter(Boolean),
        ),
      );

      if (mappedUserIds.length === 0) {
        return res.status(200).json({
          message: 'User counts fetched successfully!',
          code: 200,
          data: {},
        });
      }

      const userAccesses = await prisma.userAccess.findMany({
        where: {
          companyId,
          userId: {
            in: mappedUserIds,
          },
        },
        include: {
          role: {
            select: {
              subCategory: true,
              permissionLevel: true,
              isActive: true,
            },
          },
          orgStructure: {
            select: {
              nodePath: true,
              status: true,
            },
          },
        },
      });

      const countsMap: Record<
        string,
        { MANAGER: Set<string>; USER: Set<string>; VIEWER: Set<string> }
      > = {};

      userAccesses.forEach((ua) => {
        if (!ua.role?.isActive) {
          return;
        }

        if (ua.orgStructure?.status !== 'ACTIVE' && !ua.isGlobalAccess) {
          return;
        }

        if (!UserDbController.doesAccessCoverNode(ua, normalizedNodePath)) {
          return;
        }

        const subCat = String(ua.role?.subCategory || '').trim();
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

      const finalData: Record<string, any> = {};

      Object.entries(countsMap).forEach(([subCat, levels]) => {
        const managerCount = levels.MANAGER.size;
        const userCount = levels.USER.size;
        const viewerCount = levels.VIEWER.size;

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
