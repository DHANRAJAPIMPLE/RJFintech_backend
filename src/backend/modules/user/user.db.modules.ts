import type { Request, Response, NextFunction } from 'express';
import { prisma, ltree } from '../../lib/prisma';
import { HashUtil } from '../../../shared/utils/hash.util';
import { AppError } from '../../middlewares/error.middleware';
import { getPagination } from '../../../shared/utils/pagination.util';
import { WorkflowApproverUtil } from '../../utils/workflow-approver.util';
import { NotificationService } from '../notifications/notification.db.modules';
import { HistoryUserUtil } from '../../utils/history-user.util';

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
  levelsHash: string;
  name: string;
  alias: string;
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

/**
 * Controller for managing user accounts, mappings to companies, and onboarding workflows.
 * Handles production user data and pending user requests.
 */
export class UserDbController {
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

    return [
      permission.accessType,
      permission.nodePath,
      permission.roleSubCategory,
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
    const rank = new Map(
      roles.map((role) => [
        role.roleName,
        { VIEWER: 1, USER: 2, MANAGER: 3 }[
          String(role.permissionLevel || '').toUpperCase()
        ] || 0,
      ]),
    );
    const hasLowerRole = diff.updated.some(
      (change) =>
        (rank.get(change.newData.roleName) || 0) <
        (rank.get(change.oldData.roleName) || 0),
    );
    const hasHigherRole = diff.updated.some(
      (change) =>
        (rank.get(change.newData.roleName) || 0) >=
        (rank.get(change.oldData.roleName) || 0),
    );

    if (diff.removed.length > 0 || hasLowerRole) return 'DOWNGRADE';
    if (diff.added.length > 0 || hasHigherRole) return 'UPGRADE';
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
        label: name ? `${name} (${email})` : email,
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
      },
      orderBy: { createdAt: 'desc' },
      select: {
        levelsHash: true,
        name: true,
        alias: true,
      },
    });
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

  private static formatProductionUser(u: any, pendingRequest?: any) {
    const mapping = u.userMappings[0];

    return {
      pendingRequest: pendingRequest
        ? {
            id: pendingRequest.id,
            type: pendingRequest.type,
            status: pendingRequest.status,
            oldData:
              pendingRequest.oldData ||
              ((pendingRequest.data as any)?.oldData ?? null),
            newData: pendingRequest.data || null,
            createdAt: pendingRequest.createdAt,
          }
        : null,
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

  private static isPendingOnboardingVisibleToNodePaths(
    onboarding: any,
    visibleNodePaths: Set<string>,
  ) {
    const data = onboarding.data as any;
    const basic = data?.basicDetails || {};
    const permissions = Array.isArray(data?.permissions)
      ? data.permissions
      : [];

    const isGlobalRequest =
      basic.isGlobalUser === true ||
      permissions.some((p: any) => p.roleName === 'Corp Admin');

    if (isGlobalRequest) return false;

    return permissions.some(
      (p: any) =>
        (p.accessType === 'PRIMARY' || p.accessType === 'SECONDARY') &&
        typeof p.nodePath === 'string' &&
        visibleNodePaths.has(p.nodePath),
    );
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
    } = params;
    const effectiveDirection = cursor ? direction : 'next';

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

    if (!isGlobal && visibleNodePaths.length === 0) {
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

    const visibleNodePathSet = new Set(visibleNodePaths);

    const where = {
      status: 'PENDING' as const,
      companyId: resolvedCompanyId,
    };

    const allPendingOnboardings = await prisma.userOnboarding.findMany({
      where,
      orderBy: UserDbController.getPageOrder(effectiveDirection),
    });

    const visiblePendingOnboardings = allPendingOnboardings.filter(
      (onb) =>
        (isGlobal ||
          UserDbController.isPendingOnboardingVisibleToNodePaths(
            onb,
            visibleNodePathSet,
          )) &&
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

    return pendingOnboardings.map((onb: any) => {
      const dataBlob = onb.data as any;
      const basic = dataBlob?.basicDetails || {};
      const permissions = dataBlob?.permissions || [];
      const email = basic.email || dataBlob?.targetUserEmail;
      const historyEmail = dataBlob?.targetUserEmail || email;
      const managerEmail = basic.reportingManager;
      const init = historyMap.get(`${historyEmail}_INITIATE`);
      const approve = historyMap.get(`${historyEmail}_APPROVED`);
      const managerInfo = managerMap.get(managerEmail);
      const w = onb.workflowId ? workflowMap.get(onb.workflowId) : null;

      const primary: any[] = [];
      const secondary: any[] = [];

      permissions.forEach((p: any) => {
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
        type: onb.type || 'INITIATE',
        oldData: onb.oldData || dataBlob?.oldData || null,
        newData: dataBlob || null,
        approver: approve?.user || null,
        basicDetails: {
          name: basic.name,
          email: basic.email,
          phone: basic.phone,
          createdAt: onb.createdAt,
          designation: basic.designation || null,
          employeeId: basic.employeeId || null,
          status: basic.status || null,
          reportingManagerName: managerInfo?.name || null,
          reportingManagerEmail: managerInfo?.email || null,
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
      const activePageWhere =
        listType === 'active' && cursor
          ? UserDbController.appendCursorWhere(
              activeWhere,
              cursor,
              effectiveDirection === 'prev' ? 'newer' : 'older',
            )
          : activeWhere;
      const activeNewWhere =
        listType === 'active' && topCursor
          ? UserDbController.appendCursorWhere(activeWhere, topCursor, 'newer')
          : null;

      const [activeRows, inactiveRows, pendingResult, activeNewCount] =
        await Promise.all([
          listType === 'pending'
            ? Promise.resolve([])
            : prisma.user.findMany({
                where: activePageWhere,
                include: userInclude,
                orderBy: UserDbController.getPageOrder(effectiveDirection),
                ...(listType === 'active'
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
              }),
          activeNewWhere
            ? prisma.user.count({ where: activeNewWhere })
            : Promise.resolve(0),
        ]);

      const activePage =
        listType === 'active'
          ? UserDbController.buildPageInfo(
              activeRows,
              limit,
              requestedTopCursor,
              activeNewCount,
              effectiveDirection,
              cursor,
              page,
              isPagePagination,
            )
          : { pageRows: activeRows, pageInfo: null };
      const firstActivePageRow = activePage.pageRows[0];
      if (
        listType === 'active' &&
        !isPagePagination &&
        cursor &&
        firstActivePageRow &&
        activePage.pageInfo
      ) {
        const newerCount = await prisma.user.count({
          where: UserDbController.appendCursorWhere(
            activeWhere,
            firstActivePageRow,
            'newer',
          ),
        });
        activePage.pageInfo.page = Math.floor(newerCount / limit) + 1;
      }
      const activeEmails = activePage.pageRows
        .map((user: any) => user.email)
        .filter(Boolean);
      const activePendingRequests =
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
      const activeUsers = activePage.pageRows.map((user: any) =>
        UserDbController.formatProductionUser(
          user,
          activePendingByEmail.get((user.email || '').toLowerCase()),
        ),
      );
      const inactiveUsers = inactiveRows.map(
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
          listType === 'active'
            ? activePage.pageInfo
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

        permissions.forEach((permission: any) => {
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

        permissions.forEach((permission: any) => {
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
      throw new AppError('Only active users can be disabled or archived', 400);
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
      throw new AppError(
        'User already has a pending onboarding or modification request',
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

    const oldBasicDetails: Record<string, unknown> = {};
    for (const field of editableFields) {
      if (
        current.snapshot.basicDetails[field] !== proposed.basicDetails[field]
      ) {
        oldBasicDetails[field] = current.snapshot.basicDetails[field];
      }
    }
    if (statusChanged) {
      oldBasicDetails.status = current.snapshot.basicDetails.status;
    }

    const changedOldData: Record<string, unknown> = {};
    if (Object.keys(oldBasicDetails).length > 0) {
      changedOldData.basicDetails = oldBasicDetails;
    }
    const changedOldPermissions = [
      ...permissionDiff.removed,
      ...permissionDiff.updated.map((change) => change.oldData),
    ];
    if (changedOldPermissions.length > 0) {
      changedOldData.permissions = changedOldPermissions;
    }

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
        throw new AppError(
          'User access cannot be reduced while the user is required on a pending approval workflow',
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
          oldData: changedOldData as any,
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

    await NotificationService.createRequestNotification({
      companyId,
      type: 'INITIATE',
      referenceType: 'USER',
      referenceId: onboarding.id,
      referenceName: current.user.email,
      createdBy: initiatorId,
      recipientUserIds: notificationRecipients,
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
    const type = UserDbController.normalizeUserRequestType(req.body?.type);
    if (type !== 'INITIATE') {
      return UserDbController.createUserModificationRequest(req, res, type);
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

    const email = onboardingData.data?.basicDetails?.email;
    const permissions = onboardingData.data?.permissions || [];
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
      referenceName: email,
      createdBy: initiatorId,
      recipientUserIds: notificationRecipients,
    });
    res.status(201).json(onboarding);
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

              const node = await tx.orgStructure.findUnique({
                where: { nodePath },
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

                // ─── B. DOWNWARD PROPAGATION: New user to existing child nodes ───
                if (
                  finalCategory === 'ALL_CHILD' ||
                  finalCategory === 'IMMEDIATE_CHILD'
                ) {
                  const children = await tx.orgStructure.findMany({
                    where: {
                      companyId: company.id,
                      ...(finalCategory === 'ALL_CHILD'
                        ? { nodePath: { startsWith: `${nodePath}.` } }
                        : { parent: { nodePath } }),
                    },
                  });

                  if (children.length > 0) {
                    const childAccesses = children.map((child) => ({
                      userId: user.id,
                      roleCode: role.roleCode,
                      nodeId: child.id,
                      accessType: 'SECONDARY' as any,
                      accessCategory:
                        finalCategory === 'IMMEDIATE_CHILD'
                          ? ('NODE' as any)
                          : ('ALL_CHILD' as any),
                      companyId: company.id,
                      isGlobalAccess: false,
                    }));

                    await tx.userAccess.createMany({
                      data: childAccesses,
                      skipDuplicates: true,
                    });
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

      let message = `User onboarding ${status}d successfully`;
      if (result && result.status === 'PARTIAL_APPROVED') {
        message = `User request approved at Level ${result.level}, pending remaining approval`;
        notificationRecipients =
          await NotificationService.getCurrentApproverIds(
            id,
            'user_onboarding',
            notificationRecipients,
          );
      } else if (result && result.status === 'APPROVED') {
        message =
          onboarding.type && onboarding.type !== 'INITIATE'
            ? `User ${onboarding.type.toLowerCase()} request approved`
            : 'User approved and onboarded';
      } else if (result && result.status === 'REJECTED') {
        message = 'User request rejected';
      }

      const requestInitiatorId =
        await NotificationService.getRequestInitiatorId(id, 'user_onboarding');
      const notificationRecipientUserIds =
        NotificationService.mergeRecipientUserIds(
          notificationRecipients,
          requestInitiatorId,
        );

      await NotificationService.createRequestNotification({
        companyId: onboarding.companyId,
        type:
          result?.status === 'REJECTED'
            ? 'REJECT'
            : result?.status === 'APPROVED'
              ? 'ONBOARDED'
              : 'APPROVE',
        referenceType: 'USER',
        referenceId: id,
        referenceName: name || email,
        createdBy: approverId,
        recipientUserIds: notificationRecipientUserIds,
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
              select: { id: true, data: true, oldData: true },
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
              const approvers = (currentPending.approversList as string[])
                .map((id) => {
                  const u = approverMap.get(id);
                  return u ? { name: u.name, email: u.email } : null;
                })
                .filter(Boolean);

              resultList.push({
                email: h.email,
                companyCode: h.company.companyCode,
                oldData:
                  requestSnapshotMap.get(h.reqId)?.oldData ||
                  ((requestSnapshotMap.get(h.reqId)?.data as any)?.oldData ??
                    null),
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
          email: h.email,
          companyCode: h.company.companyCode,
          oldData: h.reqId
            ? requestSnapshotMap.get(h.reqId)?.oldData ||
              ((requestSnapshotMap.get(h.reqId)?.data as any)?.oldData ?? null)
            : null,
          event: h.event,
          level: h.level,
          createdAt: h.createdAt,
          remarks: h.remarks,
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

      if (globalAccess) {
        const companyNodes = await prisma.orgStructure.findMany({
          where: { companyId },
          select: {
            nodeName: true,
            nodePath: true,
            nodeType: true,
            workflows: {
              where: {
                ...(workflowSubCategory
                  ? { subModule: workflowSubCategory }
                  : {}),
              },
              select: {
                levelsHash: true,
                name: true,
                alias: true,
              },
            },
          },
        });

        const nodes = companyNodes.map((node) => ({
          ...UserDbController.withDefaultWorkflowOption(node, defaultWorkflow),
          roleName: globalAccess.role?.roleName || globalAccess.roleCode,
        }));

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
                workflows: {
                  where: { subModule: workflowSubCategory },
                  select: {
                    levelsHash: true,
                    name: true,
                    alias: true,
                  },
                },
              },
            },
          },
        });

        const nodes = userAccesses
          .map((ua) => ({
            ...UserDbController.withDefaultWorkflowOption(
              ua.orgStructure,
              defaultWorkflow,
            ),
            roleName: ua.role?.roleName || ua.roleCode,
          }))
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
