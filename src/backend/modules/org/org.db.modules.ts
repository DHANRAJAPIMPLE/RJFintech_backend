import type { Request, Response, NextFunction } from 'express';
import { prisma, ltree } from '../../lib/prisma';
import { AppError } from '../../middlewares/error.middleware';
import { WorkflowApproverUtil } from '../../utils/workflow-approver.util';
import { NotificationService } from '../notifications/notification.db.modules';
import { HistoryUserUtil } from '../../utils/history-user.util';
import { cloneJson, mergeJsonData } from '../../utils/json-patch.util';

type OrgNodeStatus = 'ACTIVE' | 'INACTIVE';

type OrgNodeSnapshot = {
  newNodeName: string;
  nodeType: string;
  nodePath: string;
  parentNode: {
    nodeName: string;
    nodePath: string;
  };
  status: OrgNodeStatus;
};

type OrgInactivationNotification = {
  nodeName: string;
  nodePath: string;
  accessUserIds: string[];
  userNames: string[];
  users: Array<{
    name: string;
    email: string | null;
  }>;
  workflowCount: number;
  workflowNames: string[];
  workflows: Array<{
    workflowName: string;
    alias: string | null;
  }>;
};

type OrgImpactSummary = {
  userAccess: Array<{
    name: string;
    email: string | null;
  }>;
  workflow: Array<{
    workflowName: string;
    alias: string | null;
  }>;
};

type OrgAutoDeletedWorkflowNotification = {
  workflowName: string;
  nodeName: string;
  nodePath: string;
  workflowReqIds?: string[];
};

type PendingUserAccessRemovalNotification = {
  requestId: string;
  initiatorId: string | null;
  eligibleApprovers: string[];
  targetUserName: string;
  targetUserEmail: string | null;
  removedPermissions: Array<{
    nodeName: string;
    nodePath: string;
    roleName: string;
  }>;
};

type PendingWorkflowDeletionNotification = {
  requestId: string;
  initiatorId: string | null;
  eligibleApprovers: string[];
  workflowName: string;
  targetNodePath: string;
};

type AutoUserAccessAuditEntry = {
  userId: string;
  userName: string | null;
  userEmail: string | null;
  roleCode: string;
  roleName: string;
  roleCategory: string;
  roleSubCategory: string;
  nodeId: string;
  nodeName: string;
  nodePath: string;
  accessType: 'PRIMARY' | 'SECONDARY';
  accessCategory: 'ALL_CHILD' | 'IMMEDIATE_CHILD' | 'NODE' | null;
  companyId: string;
  isGlobalAccess: boolean;
};

type PendingUserPermissionSnapshot = {
  accessType: 'PRIMARY' | 'SECONDARY';
  roleName: string;
  roleCategory: string;
  roleSubCategory: string;
  nodeName: string;
  nodePath: string;
  accessCategory: 'ALL_CHILD' | 'IMMEDIATE_CHILD' | 'NODE' | null;
};

type OrgLinkedStructureNode = {
  nodePath: string;
  nodeName: string;
  nodeType: string;
  status: OrgNodeStatus;
  isPending: boolean;
  isAutoDeleted: boolean;
  linkedOrgStructure?: OrgLinkedStructureNode[];
};

/**
 * Controller for managing the organizational hierarchy (nodes) for companies.
 * Handles the creation, approval, and retrieval of organization units (Roots, Groups, Locations, etc.)
 */
export class OrgStructureDbController {
  private static getOrgHistoryDisplayEvent(
    event: string | null | undefined,
    requestType: string | null | undefined,
  ) {
    const normalizedEvent = String(event || '').toUpperCase();
    if (normalizedEvent !== 'INITIATE') return normalizedEvent || event;

    const normalizedType = String(requestType || 'INITIATE').toUpperCase();
    if (normalizedType === 'UPDATE') return 'MODIFY';
    if (normalizedType === 'ACTIVE') return 'ACTIVE';
    if (normalizedType === 'INACTIVE') return 'INACTIVE';
    if (normalizedType === 'ARCHIVE') return 'ARCHIVE';

    return 'INITIATE';
  }

  private static resolveOrgHistoryRequestType(
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
    const normalizedStatus = String(requestData?.status || '').toUpperCase();
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

  private static getEmptyOrgHistoryApprovalSummary() {
    return {
      currentStatus: null,
      totalLevels: 0,
      completedLevels: 0,
      rejectedAtLevel: null,
      currentPendingLevel: null,
    };
  }

  private static getOrgHistoryLevelCount(
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

  private static formatConflictDate(value: Date | string | null | undefined) {
    if (!value) return 'N/A';
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? 'N/A' : date.toISOString();
  }

  private static normalizePendingUserPermission(
    permission: any,
  ): PendingUserPermissionSnapshot {
    return {
      accessType:
        permission?.accessType === 'PRIMARY' ? 'PRIMARY' : 'SECONDARY',
      roleName:
        typeof permission?.roleName === 'string' ? permission.roleName : '',
      roleCategory:
        typeof permission?.roleCategory === 'string'
          ? permission.roleCategory
          : '',
      roleSubCategory:
        typeof permission?.roleSubCategory === 'string'
          ? permission.roleSubCategory
          : '',
      nodeName:
        typeof permission?.nodeName === 'string' ? permission.nodeName : '',
      nodePath:
        typeof permission?.nodePath === 'string' ? permission.nodePath : '',
      accessCategory:
        permission?.accessCategory === 'ALL_CHILD' ||
        permission?.accessCategory === 'IMMEDIATE_CHILD' ||
        permission?.accessCategory === 'NODE'
          ? permission.accessCategory
          : null,
    };
  }

  private static pendingUserPermissionsEqual(
    left: PendingUserPermissionSnapshot,
    right: PendingUserPermissionSnapshot,
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

  private static pendingUserPermissionReplacementKey(
    permission: PendingUserPermissionSnapshot,
  ) {
    if (permission.accessType === 'PRIMARY') return 'PRIMARY';

    return [
      permission.accessType,
      permission.roleName,
      permission.nodePath,
    ].join('|');
  }

  private static mergePendingUserPermissionMutations(
    existing: PendingUserPermissionSnapshot[],
    requested: any[],
  ): PendingUserPermissionSnapshot[] {
    const proposed = existing.map((permission) => ({ ...permission }));

    for (const request of requested) {
      const permission =
        OrgStructureDbController.normalizePendingUserPermission(request);
      const operation =
        request?.remove === true
          ? 'REMOVE'
          : typeof request?.operation === 'string'
            ? request.operation.trim().toUpperCase()
            : null;
      const exactIndex = proposed.findIndex((stored) =>
        OrgStructureDbController.pendingUserPermissionsEqual(
          stored,
          permission,
        ),
      );
      const replacementIndex = proposed.findIndex(
        (stored) =>
          OrgStructureDbController.pendingUserPermissionReplacementKey(
            stored,
          ) ===
          OrgStructureDbController.pendingUserPermissionReplacementKey(
            permission,
          ),
      );

      if (operation === 'REMOVE') {
        if (permission.accessType === 'PRIMARY') continue;
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

  private static getPendingWorkflowTargetNodePath(request: any) {
    const requestData = request?.data as any;
    const target = requestData?.target;

    return (
      (typeof target?.nodePath === 'string' && target.nodePath) ||
      (typeof requestData?.nodePath === 'string' && requestData.nodePath) ||
      (typeof request?.orgStructure?.nodePath === 'string' &&
        request.orgStructure.nodePath) ||
      null
    );
  }

  private static async resolvePendingUserPermissions(tx: any, request: any) {
    const requestData = (request?.data || {}) as any;
    const requestedPermissions = Array.isArray(requestData.permissions)
      ? requestData.permissions
      : [];
    const requestType = String(request?.type || 'INITIATE').toUpperCase();

    if (requestType === 'INITIATE') {
      return OrgStructureDbController.mergePendingUserPermissionMutations(
        [],
        requestedPermissions,
      );
    }

    const targetEmail =
      (typeof requestData?.targetUserEmail === 'string' &&
        requestData.targetUserEmail) ||
      (typeof requestData?.basicDetails?.email === 'string' &&
        requestData.basicDetails.email) ||
      null;
    if (!targetEmail) {
      return OrgStructureDbController.mergePendingUserPermissionMutations(
        [],
        requestedPermissions,
      );
    }

    const targetUser = await tx.user.findUnique({
      where: { email: targetEmail },
      select: { id: true },
    });
    if (!targetUser) {
      return OrgStructureDbController.mergePendingUserPermissionMutations(
        [],
        requestedPermissions,
      );
    }

    const currentPermissions = await tx.userAccess.findMany({
      where: {
        companyId: request.companyId,
        userId: targetUser.id,
      },
      select: {
        accessType: true,
        accessCategory: true,
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
          },
        },
      },
    });

    return OrgStructureDbController.mergePendingUserPermissionMutations(
      currentPermissions.map((permission: any) => ({
        accessType: permission.accessType,
        roleName: permission.role?.roleName || '',
        roleCategory: permission.role?.category || '',
        roleSubCategory: permission.role?.subCategory || '',
        nodeName: permission.orgStructure?.nodeName || '',
        nodePath: permission.orgStructure?.nodePath || '',
        accessCategory: permission.accessCategory || null,
      })),
      requestedPermissions,
    );
  }

  private static async rejectPendingUserRequestsForOrgInactivation(
    tx: any,
    params: {
      companyId: string;
      nodePath: string;
      nodeName: string;
      actorId?: string;
    },
  ) {
    const pendingRequests = await tx.userOnboarding.findMany({
      where: {
        companyId: params.companyId,
        status: 'PENDING',
        type: { in: ['INITIATE', 'UPDATE'] },
      },
      select: {
        id: true,
        type: true,
        companyId: true,
        data: true,
      },
    });

    for (const request of pendingRequests) {
      const resolvedPermissions =
        await OrgStructureDbController.resolvePendingUserPermissions(
          tx,
          request,
        );
      const primaryPermission = resolvedPermissions.find(
        (permission) =>
          permission.accessType === 'PRIMARY' &&
          typeof permission.nodePath === 'string' &&
          permission.nodePath &&
          OrgStructureDbController.pathWithinSubtree(
            permission.nodePath,
            params.nodePath,
          ),
      );
      if (!primaryPermission) continue;

      const currentPendingLevel = await tx.workflowApprover.findFirst({
        where: {
          reqId: request.id,
          reqTable: 'user_onboarding',
          status: 'PENDING',
        },
        orderBy: { level: 'asc' },
        select: { level: true },
      });
      const remark = `Auto-rejected because organization ${params.nodeName} (${params.nodePath}) was inactivated and this request includes PRIMARY access for node ${primaryPermission.nodePath}.`;

      await WorkflowApproverUtil.rejectAllLevels(
        tx,
        request.id,
        'user_onboarding',
      );
      await tx.userOnboarding.update({
        where: { id: request.id },
        data: {
          status: 'REJECTED',
          approvalRemark: remark,
        },
      });

      const requestData = request.data as any;
      const historyEmail =
        request.type === 'INITIATE'
          ? requestData?.basicDetails?.email
          : requestData?.targetUserEmail || requestData?.basicDetails?.email;
      if (params.actorId && typeof historyEmail === 'string' && historyEmail) {
        await tx.userHistory.create({
          data: {
            email: historyEmail,
            event: 'REJECTED',
            eventUserId: params.actorId,
            companyId: params.companyId,
            reqId: request.id,
            level: currentPendingLevel?.level || null,
            remarks: remark,
          },
        });
      }
    }
  }

  private static getPendingUserTargetName(requestData: any) {
    const name =
      (typeof requestData?.basicDetails?.name === 'string' &&
        requestData.basicDetails.name.trim()) ||
      (typeof requestData?.targetUserName === 'string' &&
        requestData.targetUserName.trim()) ||
      '';
    const email =
      (typeof requestData?.basicDetails?.email === 'string' &&
        requestData.basicDetails.email.trim()) ||
      (typeof requestData?.targetUserEmail === 'string' &&
        requestData.targetUserEmail.trim()) ||
      null;

    return {
      targetUserName: name || email || 'user',
      targetUserEmail: email,
    };
  }

  private static async assertNoPendingPrimaryAccessRequestsInSubtree(
    tx: any,
    params: {
      companyId: string;
      nodePath: string;
      nodeName: string;
    },
  ) {
    const pendingRequests = await tx.userOnboarding.findMany({
      where: {
        companyId: params.companyId,
        status: 'PENDING',
        type: { in: ['INITIATE', 'UPDATE'] },
      },
      select: {
        id: true,
        type: true,
        data: true,
      },
    });
    const conflicts: string[] = [];

    for (const request of pendingRequests) {
      const requestData = request.data as any;
      const requestedPermissions = Array.isArray(requestData?.permissions)
        ? requestData.permissions
        : [];
      const primaryPermission = requestedPermissions.find((permission: any) => {
        const operation =
          permission?.remove === true
            ? 'REMOVE'
            : typeof permission?.operation === 'string'
              ? permission.operation.trim().toUpperCase()
              : null;

        return (
          operation !== 'REMOVE' &&
          permission?.accessType === 'PRIMARY' &&
          typeof permission.nodePath === 'string' &&
          permission.nodePath &&
          OrgStructureDbController.pathWithinSubtree(
            permission.nodePath,
            params.nodePath,
          )
        );
      });
      if (!primaryPermission) continue;

      const target =
        OrgStructureDbController.getPendingUserTargetName(requestData);
      conflicts.push(
        `${target.targetUserEmail || target.targetUserName} (${primaryPermission.nodePath})`,
      );
    }

    if (conflicts.length > 0) {
      const top = conflicts
        .slice(0, 10)
        .map((conflict) => `- ${conflict}`)
        .join('\n');
      const remaining = Math.max(conflicts.length - 10, 0);
      const remainingLine =
        remaining > 0
          ? `\nand ${remaining} other pending user request(s)...`
          : '';
      throw new AppError(
        `Cannot inactivate node '${params.nodeName || params.nodePath}' because it has ${conflicts.length} pending primary user assignment(s). Please approve, reject, or change these pending users before deactivating:\n${top}${remainingLine}`,
        400,
      );
    }
  }

  private static async removePendingSecondaryAccessRequestsForOrgInactivation(
    tx: any,
    params: {
      companyId: string;
      nodePath: string;
    },
  ): Promise<PendingUserAccessRemovalNotification[]> {
    const pendingRequests = await tx.userOnboarding.findMany({
      where: {
        companyId: params.companyId,
        status: 'PENDING',
        type: { in: ['INITIATE', 'UPDATE'] },
      },
      select: {
        id: true,
        type: true,
        data: true,
        initiatorId: true,
        eligibleApprovers: true,
      },
    });
    const notifications: PendingUserAccessRemovalNotification[] = [];

    for (const request of pendingRequests) {
      const requestData = (request.data || {}) as any;
      const requestedPermissions = Array.isArray(requestData.permissions)
        ? requestData.permissions
        : [];
      if (requestedPermissions.length === 0) continue;

      const removedPermissions: PendingUserAccessRemovalNotification['removedPermissions'] =
        [];
      const nextPermissions = requestedPermissions.filter((permission: any) => {
        const operation =
          permission?.remove === true
            ? 'REMOVE'
            : typeof permission?.operation === 'string'
              ? permission.operation.trim().toUpperCase()
              : null;
        const shouldRemove =
          operation !== 'REMOVE' &&
          permission?.accessType !== 'PRIMARY' &&
          typeof permission?.nodePath === 'string' &&
          permission.nodePath &&
          OrgStructureDbController.pathWithinSubtree(
            permission.nodePath,
            params.nodePath,
          );

        if (shouldRemove) {
          removedPermissions.push({
            nodeName:
              typeof permission?.nodeName === 'string' && permission.nodeName
                ? permission.nodeName
                : permission.nodePath,
            nodePath: permission.nodePath,
            roleName:
              typeof permission?.roleName === 'string' && permission.roleName
                ? permission.roleName
                : 'role access',
          });
        }

        return !shouldRemove;
      });

      if (removedPermissions.length === 0) continue;

      await tx.userOnboarding.update({
        where: { id: request.id },
        data: {
          data: {
            ...requestData,
            permissions: nextPermissions,
          } as any,
          approvalRemark:
            'Secondary access under an inactivated organization node was removed from this pending request.',
        },
      });

      notifications.push({
        requestId: request.id,
        initiatorId: request.initiatorId || null,
        eligibleApprovers: Array.isArray(request.eligibleApprovers)
          ? request.eligibleApprovers
          : [],
        ...OrgStructureDbController.getPendingUserTargetName(requestData),
        removedPermissions,
      });
    }

    return notifications;
  }

  private static async rejectPendingWorkflowRequestsForOrgInactivation(
    tx: any,
    params: {
      companyId: string;
      nodePath: string;
      nodeName: string;
      actorId?: string;
    },
  ): Promise<PendingWorkflowDeletionNotification[]> {
    const pendingRequests = await tx.workflowReq.findMany({
      where: {
        companyId: params.companyId,
        status: 'PENDING',
      },
      select: {
        id: true,
        companyId: true,
        data: true,
        alias: true,
        module: true,
        subModule: true,
        initiatorId: true,
        eligibleApprovers: true,
      },
    });
    const notifications: PendingWorkflowDeletionNotification[] = [];

    for (const request of pendingRequests) {
      const targetNodePath =
        OrgStructureDbController.getPendingWorkflowTargetNodePath(request);
      if (
        !targetNodePath ||
        !OrgStructureDbController.pathWithinSubtree(
          targetNodePath,
          params.nodePath,
        )
      ) {
        continue;
      }

      const currentPendingLevel = await tx.workflowApprover.findFirst({
        where: {
          reqId: request.id,
          reqTable: 'workflow_req',
          status: 'PENDING',
        },
        orderBy: { level: 'asc' },
        select: { level: true },
      });
      const remark = `Auto-rejected because organization ${params.nodeName} (${params.nodePath}) was inactivated and this workflow request targets node ${targetNodePath}.`;

      await WorkflowApproverUtil.rejectAllLevels(
        tx,
        request.id,
        'workflow_req',
      );
      await tx.workflowReq.update({
        where: { id: request.id },
        data: {
          status: 'REJECTED',
          approvalRemark: remark,
        },
      });

      if (params.actorId) {
        await tx.workflowReqHistory.create({
          data: {
            workflowReqId: request.id,
            companyId: params.companyId,
            event: 'REJECTED',
            eventUserId: params.actorId,
            level: currentPendingLevel?.level || null,
            remarks: remark,
          },
        });
      }

      const requestData = request.data as any;
      notifications.push({
        requestId: request.id,
        initiatorId: request.initiatorId || null,
        eligibleApprovers: Array.isArray(request.eligibleApprovers)
          ? request.eligibleApprovers
          : [],
        workflowName:
          (typeof requestData?.name === 'string' && requestData.name.trim()) ||
          (typeof request.alias === 'string' && request.alias.trim()) ||
          [request.module, request.subModule].filter(Boolean).join(' / ') ||
          'workflow',
        targetNodePath,
      });
    }

    return notifications;
  }

  private static async notifyConflict(
    companyId: string,
    initiatorId: string,
    message: string,
    referenceName: string,
    approverUserIds: string[] = [],
  ) {
    const corpAdminUserIds =
      await NotificationService.getCorpAdminUserIds(companyId);
    const recipients = NotificationService.mergeRecipientUserIds(
      initiatorId,
      approverUserIds,
      corpAdminUserIds,
    );
    await NotificationService.createRequestNotification({
      companyId,
      type: 'MODIFICATION',
      name: 'Organization modification failed',
      message: `Organization modification failed: ${message}`,
      referenceType: 'ORG',
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

  private static buildLinkedOrgStructure(
    orgNodes: Array<{
      nodePath: string;
      nodeName: string;
      nodeType: string;
      status: OrgNodeStatus;
    }>,
    rootNodePath?: string | null,
    pendingNodePaths?: Set<string>,
  ): OrgLinkedStructureNode[] {
    if (!rootNodePath) return [];

    return orgNodes
      .filter(
        (node) =>
          node.nodePath !== rootNodePath &&
          node.nodePath.startsWith(`${rootNodePath}.`),
      )
      .sort((left, right) => left.nodePath.localeCompare(right.nodePath))
      .map((node) => ({
        nodePath: node.nodePath,
        nodeName: node.nodeName,
        nodeType: node.nodeType,
        status: node.status,
        isPending: pendingNodePaths?.has(node.nodePath) ?? false,
        isAutoDeleted: node.status !== 'ACTIVE',
      }));
  }

  private static pathSegment(value: string) {
    return value
      .trim()
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .toUpperCase();
  }

  private static buildImpactSummary(
    userAccess: Array<{
      name: string;
      email: string | null;
    }>,
    workflow: Array<{
      workflowName: string;
      alias: string | null;
    }>,
  ): OrgImpactSummary {
    return {
      userAccess,
      workflow,
    };
  }

  private static normalizeImpactSummary(data: any): OrgImpactSummary {
    const summary = data?.impactSummary;
    return {
      userAccess: Array.isArray(summary?.userAccess)
        ? summary.userAccess
            .map((entry: any) => {
              if (typeof entry === 'string' && entry.trim()) {
                return { name: entry.trim(), email: null };
              }
              if (typeof entry?.name === 'string' && entry.name.trim()) {
                return {
                  name: entry.name.trim(),
                  email:
                    typeof entry?.email === 'string' && entry.email.trim()
                      ? entry.email.trim()
                      : null,
                };
              }
              return null;
            })
            .filter(Boolean)
        : [],
      workflow: Array.isArray(summary?.workflow)
        ? summary.workflow
            .map((entry: any) => {
              if (typeof entry === 'string' && entry.trim()) {
                return { workflowName: entry.trim(), alias: null };
              }
              if (
                typeof entry?.workflowName === 'string' &&
                entry.workflowName.trim()
              ) {
                return {
                  workflowName: entry.workflowName.trim(),
                  alias:
                    typeof entry?.alias === 'string' && entry.alias.trim()
                      ? entry.alias.trim()
                      : null,
                };
              }
              return null;
            })
            .filter(Boolean)
        : [],
    };
  }

  private static async resolveImpactSummary(
    client: any,
    companyId: string,
    reqType: string,
    reqData: any,
  ): Promise<OrgImpactSummary> {
    const summary = reqData?.impactSummary;
    const hasImpactSummary =
      Array.isArray(summary?.userAccess) && Array.isArray(summary?.workflow);

    if (hasImpactSummary) {
      return OrgStructureDbController.normalizeImpactSummary(reqData);
    }

    if (reqType === 'INITIATE') {
      const requestedNodePath =
        OrgStructureDbController.resolveRequestedNodePath(reqData);
      const userAccess =
        await OrgStructureDbController.getPropagatedUserAccessSummaries(
          client,
          companyId,
          requestedNodePath,
        );
      const workflow =
        await OrgStructureDbController.getAutoGeneratedWorkflowTemplateSummaries(
          client,
          companyId,
          reqData.parentNode?.nodePath,
        );
      return { userAccess, workflow };
    } else {
      const nodePath = reqData?.targetNodePath || reqData?.nodePath || null;
      if (!nodePath) {
        return { userAccess: [], workflow: [] };
      }
      const notification =
        await OrgStructureDbController.getOrgInactivationNotification(
          client,
          companyId,
          nodePath,
        );
      return {
        userAccess: notification.users,
        workflow: notification.workflows,
      };
    }
  }

  private static getOrgNotificationContent(
    type: string | null | undefined,
    phase: 'initiated' | 'approved' | 'rejected',
    referenceName: string,
  ) {
    const normalizedType = String(type || 'INITIATE').toUpperCase();
    const label =
      normalizedType === 'UPDATE'
        ? 'Organization modification'
        : 'Organization onboarding';

    return {
      name: `${label} ${phase}`,
      message: `${label} request ${phase} for ${referenceName}`,
    };
  }

  private static getOrgPendingApprovalNotificationContent(
    type: string | null | undefined,
    referenceName: string,
  ) {
    const normalizedType = String(type || 'INITIATE').toUpperCase();
    const label =
      normalizedType === 'UPDATE'
        ? 'Organization modification'
        : 'Organization onboarding';

    return {
      name: `${label} approval pending`,
      message: `${label} request is pending for your approval for ${referenceName}`,
    };
  }

  private static getOrgNotificationType(
    type: string | null | undefined,
    status: string | null | undefined,
  ) {
    const normalizedStatus = String(status || '').toUpperCase();
    if (normalizedStatus === 'REJECTED') return 'REJECT' as const;
    if (normalizedStatus === 'PARTIAL_APPROVED') return 'APPROVE' as const;

    const normalizedType = String(type || 'INITIATE').toUpperCase();
    if (normalizedType === 'UPDATE') return 'MODIFICATION' as const;
    if (normalizedStatus === 'APPROVED') return 'ONBOARDED' as const;

    return 'INITIATE' as const;
  }

  private static normalizeOrgSnapshotSource(data: any) {
    return data?.newData ?? data?.data ?? data ?? {};
  }

  private static extractOrgTargetPath(data: any) {
    const source = OrgStructureDbController.normalizeOrgSnapshotSource(data);
    const targetPath =
      source?.targetNodePath ||
      source?.nodePath ||
      source?.currentData?.nodePath ||
      source?.parentNode?.nodePath ||
      null;

    return typeof targetPath === 'string' && targetPath.trim()
      ? targetPath.trim()
      : null;
  }

  private static extractOrgSnapshot(data: any) {
    const source = OrgStructureDbController.normalizeOrgSnapshotSource(data);
    const targetPath = OrgStructureDbController.extractOrgTargetPath(source);
    if (!targetPath) return null;

    return {
      newNodeName: source?.newNodeName || source?.nodeName || '',
      nodeType: source?.nodeType || source?._nodeType || 'DEPARTMENT',
      nodePath: source?.nodePath || targetPath,
      parentNode: source?.parentNode || {
        nodeName: source?.parentNodeName || 'ROOT',
        nodePath: source?.parentNodePath || 'ROOT',
      },
      status: source?.status || 'ACTIVE',
    };
  }

  private static applyOrgRequestSnapshot(current: any, request: any) {
    const source = OrgStructureDbController.normalizeOrgSnapshotSource(
      request?.data,
    );
    if (request.type === 'INITIATE' || !current) {
      return OrgStructureDbController.extractOrgSnapshot(source);
    }

    return mergeJsonData(cloneJson(current), source);
  }

  private static resolveRequestedNodePath(data: any, fallback?: string | null) {
    if (typeof fallback === 'string' && fallback.trim()) {
      return fallback.trim();
    }
    if (typeof data?.nodePath === 'string' && data.nodePath.trim()) {
      return data.nodePath.trim();
    }
    if (
      typeof data?.parentNode?.nodePath === 'string' &&
      data.parentNode.nodePath.trim() &&
      typeof data?.newNodeName === 'string' &&
      data.newNodeName.trim()
    ) {
      return `${data.parentNode.nodePath.trim()}.${OrgStructureDbController.pathSegment(data.newNodeName)}`;
    }

    return null;
  }

  private static async resolveUniqueNodePath(
    client: any,
    companyId: string,
    baseNodePath: string,
    reservedPaths: string[] = [],
  ) {
    const trimmedBaseNodePath = baseNodePath.trim();
    const existingNodes = await client.orgStructure.findMany({
      where: {
        companyId,
        OR: [
          { nodePath: trimmedBaseNodePath },
          { nodePath: { startsWith: `${trimmedBaseNodePath}` } },
        ],
      },
      select: { nodePath: true },
    });

    const existingPaths = new Set(
      existingNodes
        .map((node: any) => node.nodePath)
        .filter(
          (nodePath: unknown): nodePath is string =>
            typeof nodePath === 'string' && nodePath.length > 0,
        ),
    );
    reservedPaths
      .filter(
        (nodePath): nodePath is string =>
          typeof nodePath === 'string' && nodePath.trim().length > 0,
      )
      .forEach((nodePath) => existingPaths.add(nodePath.trim()));
    if (!existingPaths.has(trimmedBaseNodePath)) {
      return trimmedBaseNodePath;
    }

    let suffix = 1;
    while (existingPaths.has(`${trimmedBaseNodePath}${suffix}`)) {
      suffix += 1;
    }

    return `${trimmedBaseNodePath}${suffix}`;
  }

  private static async resolveUniqueRequestedNodePath(
    client: any,
    companyId: string,
    requestData: any,
  ) {
    const requestedNodePath =
      OrgStructureDbController.resolveRequestedNodePath(requestData);
    if (!requestedNodePath) return null;

    const existingRequests = await client.orgStructureReq.findMany({
      where: {
        companyId,
      },
      select: {
        id: true,
        status: true,
        data: true,
      },
    });
    const effectivePendingIds =
      await OrgStructureDbController.filterEffectivelyPendingRequestIds(
        'org_structure_req',
        existingRequests
          .filter((request: any) => request.status === 'PENDING')
          .map((request: any) => request.id),
      );
    const reservedRequestPaths = existingRequests
      .filter(
        (request: any) =>
          request.status !== 'PENDING' || effectivePendingIds.has(request.id),
      )
      .map((request: any) =>
        OrgStructureDbController.resolveRequestedNodePath(
          request.data as any,
          OrgStructureDbController.extractOrgTargetPath(request.data as any),
        ),
      )
      .filter(
        (nodePath: unknown): nodePath is string =>
          typeof nodePath === 'string' && nodePath.trim().length > 0,
      );

    return OrgStructureDbController.resolveUniqueNodePath(
      client,
      companyId,
      requestedNodePath,
      reservedRequestPaths,
    );
  }

  private static formatUserAccessImpact(count: number) {
    return count > 0 ? `${count} USER_ACCESS_ADDED` : 'NO_ISSUES';
  }

  private static toWorkflowLevelsPayload(levels: any[]) {
    return levels.reduce(
      (payload, level) => {
        payload[`l${level.level}`] = {
          approver1: level.approver1,
          approver2: level.approver2 || null,
          type: level.approverType || 'OR',
        };
        return payload;
      },
      {} as Record<string, any>,
    );
  }

  private static async autoGenerateChildWorkflows(
    tx: any,
    params: {
      companyId: string;
      parentNodeId?: string | null;
      newNode: {
        id: string;
        nodePath: string;
        nodeName: string;
        nodeType: string;
      };
      orgReqId: string;
      actorId: string;
    },
  ) {
    const { companyId, parentNodeId, newNode, orgReqId, actorId } = params;
    if (!parentNodeId) return [];

    const parentNode = await tx.orgStructure.findFirst({
      where: { id: parentNodeId, companyId },
      select: { id: true, nodePath: true, nodeName: true, nodeType: true },
    });
    if (!parentNode) return [];

    const parentWorkflows = await tx.workflow.findMany({
      where: {
        companyId,
        nodeId: parentNodeId,
        status: 'ACTIVE',
        type: { in: ['ALL_CHILD', 'IMMEDIATE_CHILD'] },
      },
      include: {
        levels: { orderBy: { level: 'asc' } },
      },
    });

    const generated = [];
    for (const source of parentWorkflows) {
      const targetType =
        source.type === 'IMMEDIATE_CHILD' ? 'NODE' : source.type;
      const duplicate = await tx.workflow.findUnique({
        where: {
          // eslint-disable-next-line @typescript-eslint/naming-convention -- Prisma compound unique field.
          companyId_nodeId_module_subModule_levelsHash: {
            companyId,
            nodeId: newNode.id,
            module: source.module,
            subModule: source.subModule,
            levelsHash: source.levelsHash,
          },
        },
        select: { id: true },
      });
      if (duplicate) continue;

      const levelsPayload = OrgStructureDbController.toWorkflowLevelsPayload(
        source.levels,
      );
      const autoData = {
        name: source.name,
        alias: source.alias,
        workflowType: targetType,
        module: source.module,
        subModule: source.subModule,
        nodePath: newNode.nodePath,
        nodeName: newNode.nodeName,
        nodeType: newNode.nodeType,
        levels: levelsPayload,
        levelsHash: source.levelsHash,
        roleCode: source.roleCode || null,
        sourceWorkflowId: source.id,
        sourceWorkflowName: source.name,
        sourceWorkflowType: source.type,
        sourceNodeId: parentNode.id,
        sourceNodeName: parentNode.nodeName,
        sourceNodePath: parentNode.nodePath,
        targetNodeId: newNode.id,
        targetNodePath: newNode.nodePath,
        parentOrgReqId: orgReqId,
      };

      const workflowReq = await tx.workflowReq.create({
        data: {
          companyId,
          nodeId: newNode.id,
          module: source.module,
          subModule: source.subModule,
          levelsHash: source.levelsHash,
          workflowId: source.id,
          type: 'AUTO_GENERATE',
          impact: 'AUTO_GENERATE',
          initiatorId: actorId,
          status: 'APPROVED',
          data: autoData,
          alias: source.alias,
          approvalRemark: `Auto-generated from parent workflow ${source.name} for node ${newNode.nodeName} (${newNode.nodePath})`,
          eligibleApprovers: [],
        },
      });

      const workflow = await tx.workflow.create({
        data: {
          name: source.name,
          alias: source.alias,
          module: source.module,
          subModule: source.subModule,
          type: targetType,
          roleCode: source.roleCode || null,
          companyId,
          nodeId: newNode.id,
          levelsHash: source.levelsHash,
          workflowReqIds: [workflowReq.id],
        },
      });

      if (source.levels.length > 0) {
        await tx.workflowLevel.createMany({
          data: source.levels.map((level: any) => ({
            workflowId: workflow.id,
            level: level.level,
            approver1: level.approver1,
            approver2: level.approver2 || null,
            approverType: level.approverType || 'OR',
          })),
        });
      }

      await tx.workflowReq.update({
        where: { id: workflowReq.id },
        data: { workflowId: workflow.id },
      });

      await tx.workflowReqHistory.create({
        data: {
          workflowReqId: workflowReq.id,
          companyId,
          event: 'AUTO_GENERATE',
          eventUserId: actorId,
          remarks: `Auto-generated workflow ${source.name} for node ${newNode.nodeName} (${newNode.nodePath}) from parent workflow ${source.name} on ${parentNode.nodeName} (${parentNode.nodePath})`,
        },
      });

      generated.push({
        workflowName: workflow.name,
        alias: workflow.alias,
        module: workflow.module,
        subModule: workflow.subModule,
        workflowType: targetType,
        nodeName: newNode.nodeName,
        nodePath: newNode.nodePath,
        sourceWorkflowName: source.name,
        sourceNodeName: parentNode.nodeName,
        sourceNodePath: parentNode.nodePath,
      });
    }

    return generated;
  }

  private static async notifyAutoGeneratedWorkflows(params: {
    companyId: string;
    orgReqId: string;
    createdBy: string;
    generatedWorkflows: Array<{
      workflowName: string;
      alias: string;
      module: string;
      subModule: string;
      workflowType: string;
      nodeName: string;
      nodePath: string;
      sourceWorkflowName: string;
      sourceNodeName: string;
      sourceNodePath: string;
    }>;
  }) {
    const { companyId, generatedWorkflows } = params;
    if (generatedWorkflows.length === 0) return;

    const corpAdminAccesses = await prisma.userAccess.findMany({
      where: {
        companyId,
        roleCode: 'CORP_ADMIN',
        user: {
          userMappings: {
            some: { companyId, status: 'ACTIVE' },
          },
        },
      },
      select: { userId: true },
    });
    const recipientUserIds = NotificationService.mergeRecipientUserIds(
      corpAdminAccesses.map((access) => access.userId),
    );
    const generatedSummary = generatedWorkflows
      .map(
        (workflow) =>
          `${workflow.workflowName} for ${workflow.nodeName} (${workflow.nodePath})`,
      )
      .join(', ');

    await NotificationService.createRequestNotification({
      companyId,
      type: 'ONBOARDED',
      name: 'Workflow auto-generated',
      message: `System auto-generated ${generatedWorkflows.length} workflow(s): ${generatedSummary}.`,
      referenceType: 'WORKFLOW',
      referenceId: params.orgReqId,
      referenceName: generatedWorkflows[0]?.nodeName || 'workflow',
      createdBy: params.createdBy,
      recipientUserIds,
      isPending: false,
    });
  }

  private static async notifyAutoDeletedWorkflows(params: {
    companyId: string;
    orgReqId: string;
    createdBy: string;
    deletedWorkflows: Array<{
      workflowName: string;
      nodeName: string;
      nodePath: string;
      workflowReqIds?: string[];
    }>;
  }) {
    if (params.deletedWorkflows.length === 0) return;

    const workflowReqIds = Array.from(
      new Set(
        params.deletedWorkflows.flatMap((workflow) =>
          Array.isArray(workflow.workflowReqIds) ? workflow.workflowReqIds : [],
        ),
      ),
    );
    const workflowInitiators =
      workflowReqIds.length > 0
        ? await prisma.workflowReqHistory.findMany({
            where: {
              workflowReqId: { in: workflowReqIds },
              event: 'INITIATE',
            },
            select: { eventUserId: true },
          })
        : [];
    const recipientUserIds = NotificationService.mergeRecipientUserIds(
      await NotificationService.getRequestInitiatorId(
        params.orgReqId,
        'org_structure_req',
      ),
      workflowInitiators.map((history) => history.eventUserId),
      await NotificationService.getCorpAdminUserIds(params.companyId),
    );
    const deletedSummary = params.deletedWorkflows
      .slice(0, 5)
      .map(
        (workflow) =>
          `${workflow.workflowName} for ${workflow.nodeName} (${workflow.nodePath})`,
      )
      .join(', ');

    await NotificationService.createRequestNotification({
      companyId: params.companyId,
      type: 'AUTO_DELETE',
      name: 'Workflow deleted because organization was inactivated',
      message: `Workflow(s) were deleted because the related organization node was inactivated: ${deletedSummary || 'workflow'}.`,
      referenceType: 'WORKFLOW',
      referenceId: params.orgReqId,
      referenceName: deletedSummary || 'workflow',
      createdBy: params.createdBy,
      recipientUserIds,
      includeCreatedBy: true,
    });
  }

  private static async getPropagatingParentAccesses(
    client: any,
    companyId: string,
    newNodePath: string,
  ) {
    const parentPaths = ltree.getAncestors(newNodePath);
    if (parentPaths.length === 0) {
      return [];
    }

    const parentNodes = await client.orgStructure.findMany({
      where: {
        companyId,
        nodePath: { in: parentPaths },
      },
      select: { id: true, nodePath: true },
    });
    const parentNodeIds = parentNodes.map((node: any) => node.id);
    if (parentNodeIds.length === 0) {
      return [];
    }

    const directParentPath = ltree.getParent(newNodePath);
    const directParentId = parentNodes.find(
      (node: any) => node.nodePath === directParentPath,
    )?.id;

    return client.userAccess.findMany({
      where: {
        companyId,
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
      include: {
        user: { select: { id: true, name: true, email: true } },
        role: {
          select: {
            roleName: true,
            category: true,
            subCategory: true,
          },
        },
      },
    });
  }

  private static buildPropagatedAccesses(
    parentAccesses: any[],
    newNodeId: string,
    newNode: { nodeName: string; nodePath: string },
  ) {
    const newAccessesMap = new Map<string, any>();

    for (const access of parentAccesses) {
      const uniqueKey = `${access.userId}_${access.roleCode}`;
      if (newAccessesMap.has(uniqueKey)) continue;

      newAccessesMap.set(uniqueKey, {
        userId: access.userId,
        userName: access.user?.name || null,
        userEmail: access.user?.email || null,
        roleCode: access.roleCode,
        roleName: access.role?.roleName || access.roleCode,
        roleCategory: access.role?.category || 'SYSTEM_ACCESS',
        roleSubCategory: access.role?.subCategory || 'USER_ACC',
        nodeId: newNodeId,
        nodeName: newNode.nodeName,
        nodePath: newNode.nodePath,
        accessType: 'SECONDARY',
        accessCategory:
          access.accessCategory === 'IMMEDIATE_CHILD'
            ? 'NODE'
            : access.accessCategory,
        companyId: access.companyId,
        isGlobalAccess: false,
      });
    }

    return Array.from(newAccessesMap.values());
  }

  private static async resolveDefaultUserAccessWorkflowId(
    tx: any,
    companyId: string,
  ) {
    const defaultWorkflow = await tx.workflow.findFirst({
      where: {
        companyId,
        module: 'SYSTEM_ACCESS',
        subModule: 'USER_ACC',
        name: { contains: 'DEFAULT' },
        status: 'ACTIVE',
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    if (defaultWorkflow?.id) {
      return defaultWorkflow.id;
    }

    const latestWorkflow = await tx.workflow.findFirst({
      where: {
        companyId,
        module: 'SYSTEM_ACCESS',
        subModule: 'USER_ACC',
        status: 'ACTIVE',
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    return latestWorkflow?.id || null;
  }

  private static groupAutoUserAccessAuditEntries(
    entries: AutoUserAccessAuditEntry[],
    isRemoval: boolean,
  ) {
    const grouped = new Map<
      string,
      {
        userName: string | null;
        userEmail: string;
        permissions: any[];
      }
    >();

    entries.forEach((entry) => {
      const userEmail =
        typeof entry.userEmail === 'string' ? entry.userEmail.trim() : '';
      if (!userEmail) return;

      const key = entry.userId || userEmail.toLowerCase();
      const current = grouped.get(key) || {
        userName: entry.userName || null,
        userEmail,
        permissions: [],
      };

      current.permissions.push({
        ...(isRemoval ? { remove: true } : {}),
        nodeName: entry.nodeName,
        nodePath: entry.nodePath,
        roleName: entry.roleName || entry.roleCode,
        accessType: entry.accessType || 'SECONDARY',
        roleCategory: entry.roleCategory || 'SYSTEM_ACCESS',
        accessCategory: entry.accessCategory || 'NODE',
        roleSubCategory: entry.roleSubCategory || 'USER_ACC',
      });

      grouped.set(key, current);
    });

    return Array.from(grouped.values());
  }

  private static async createAutoApprovedUserAccessAuditRows(
    tx: any,
    params: {
      companyId: string;
      actorId?: string | null;
      type: 'AUTO_GENERATE' | 'AUTO_DELETE';
      impact: 'UPGRADE' | 'DOWNGRADE';
      remarks: string;
      entries: AutoUserAccessAuditEntry[];
    },
  ) {
    if (!params.actorId || params.entries.length === 0) {
      return;
    }

    const workflowId =
      await OrgStructureDbController.resolveDefaultUserAccessWorkflowId(
        tx,
        params.companyId,
      );
    const groupedEntries =
      OrgStructureDbController.groupAutoUserAccessAuditEntries(
        params.entries,
        params.type === 'AUTO_DELETE',
      );

    for (const entry of groupedEntries) {
      const data = {
        permissions: cloneJson(entry.permissions),
        targetUserEmail: entry.userEmail,
      };
      const oldData =
        params.type === 'AUTO_DELETE'
          ? {
              permissions: {
                added: [],
                removed: cloneJson(
                  entry.permissions.map(
                    ({ remove, ...permission }) => permission,
                  ),
                ),
                updated: [],
              },
              ...(entry.userName
                ? {
                    basicDetails: {
                      name: entry.userName,
                    },
                  }
                : {}),
            }
          : {
              permissions: {
                added: [],
                removed: [],
                updated: [],
              },
            };

      const request = await tx.userOnboarding.create({
        data: {
          companyId: params.companyId,
          workflowId,
          type: params.type,
          impact: params.impact,
          data: data as any,
          oldData: oldData as any,
          initiatorId: params.actorId,
          remarks: params.remarks,
          status: 'APPROVED',
          approvalRemark: params.remarks,
          eligibleApprovers: [],
        },
      });

      await tx.userHistory.create({
        data: {
          email: entry.userEmail,
          event: 'INITIATE',
          eventUserId: params.actorId,
          companyId: params.companyId,
          reqId: request.id,
          remarks: params.remarks,
        },
      });

      await tx.userHistory.create({
        data: {
          email: entry.userEmail,
          event: 'APPROVED',
          eventUserId: params.actorId,
          companyId: params.companyId,
          reqId: request.id,
          remarks: params.remarks,
        },
      });
    }
  }

  private static async countPropagatedUserAccesses(
    client: any,
    companyId: string,
    newNodePath: string | null,
  ) {
    if (!newNodePath) return 0;

    const parentAccesses =
      await OrgStructureDbController.getPropagatingParentAccesses(
        client,
        companyId,
        newNodePath,
      );

    return new Set(
      parentAccesses.map(
        (access: any) => `${access.userId}_${access.roleCode}`,
      ),
    ).size;
  }

  private static async countAutoGeneratedWorkflowTemplates(
    client: any,
    companyId: string,
    parentNodePath: string | null | undefined,
  ) {
    if (!parentNodePath) return 0;

    const parentNode = await client.orgStructure.findFirst({
      where: {
        companyId,
        nodePath: parentNodePath,
      },
      select: { id: true },
    });
    if (!parentNode?.id) return 0;

    return client.workflow.count({
      where: {
        companyId,
        nodeId: parentNode.id,
        status: 'ACTIVE',
        type: { in: ['ALL_CHILD', 'IMMEDIATE_CHILD'] },
      },
    });
  }

  private static async getPropagatedUserAccessSummaries(
    client: any,
    companyId: string,
    newNodePath: string | null,
  ): Promise<Array<{ name: string; email: string | null }>> {
    if (!newNodePath) return [];

    const parentAccesses =
      await OrgStructureDbController.getPropagatingParentAccesses(
        client,
        companyId,
        newNodePath,
      );

    const uniqueUsers = new Map<
      string,
      { name: string; email: string | null }
    >();
    parentAccesses.forEach((access: any) => {
      const name =
        typeof access.user?.name === 'string' ? access.user.name.trim() : '';
      if (!name) return;

      const email =
        typeof access.user?.email === 'string' && access.user.email.trim()
          ? access.user.email.trim()
          : null;
      const key = `${name.toLowerCase()}::${(email || '').toLowerCase()}`;
      if (!uniqueUsers.has(key)) {
        uniqueUsers.set(key, { name, email });
      }
    });

    return Array.from(uniqueUsers.values()).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  private static async getAutoGeneratedWorkflowTemplateSummaries(
    client: any,
    companyId: string,
    parentNodePath: string | null | undefined,
  ): Promise<Array<{ workflowName: string; alias: string | null }>> {
    if (!parentNodePath) return [];

    const parentNode = await client.orgStructure.findFirst({
      where: {
        companyId,
        nodePath: parentNodePath,
      },
      select: { id: true },
    });
    if (!parentNode?.id) return [];

    const workflows = await client.workflow.findMany({
      where: {
        companyId,
        nodeId: parentNode.id,
        status: 'ACTIVE',
        type: { in: ['ALL_CHILD', 'IMMEDIATE_CHILD'] },
      },
      select: { name: true, alias: true },
    });

    const uniqueWorkflows = new Map<
      string,
      { workflowName: string; alias: string | null }
    >();
    workflows.forEach((workflow: any) => {
      const workflowName =
        typeof workflow.name === 'string' ? workflow.name.trim() : '';
      if (!workflowName) return;

      const alias =
        typeof workflow.alias === 'string' && workflow.alias.trim()
          ? workflow.alias.trim()
          : null;
      const key = `${workflowName.toLowerCase()}::${(alias || '').toLowerCase()}`;
      if (!uniqueWorkflows.has(key)) {
        uniqueWorkflows.set(key, { workflowName, alias });
      }
    });

    return Array.from(uniqueWorkflows.values()).sort((left, right) =>
      left.workflowName.localeCompare(right.workflowName),
    );
  }

  private static async notifyUserAccessImpact(params: {
    companyId: string;
    orgReqId: string;
    nodeName: string;
    nodePath: string;
    createdBy: string;
    accessChanges: Array<{
      userId: string;
      userName?: string | null;
      userEmail?: string | null;
      roleName?: string | null;
      roleCode: string;
    }>;
  }) {
    const { companyId, accessChanges } = params;
    if (accessChanges.length === 0) return;

    const impactedUserIds = accessChanges.map((change) => change.userId);
    const [impactedMappings, corpAdminAccesses] = await Promise.all([
      prisma.userMapping.findMany({
        where: {
          companyId,
          userId: { in: impactedUserIds },
          status: 'ACTIVE',
        },
        select: { userId: true, reportingManager: true },
      }),
      prisma.userAccess.findMany({
        where: {
          companyId,
          roleCode: 'CORP_ADMIN',
          user: {
            userMappings: {
              some: { companyId, status: 'ACTIVE' },
            },
          },
        },
        select: { userId: true },
      }),
    ]);

    const recipientUserIds = NotificationService.mergeRecipientUserIds(
      impactedUserIds,
      impactedMappings.map((mapping) => mapping.reportingManager),
      corpAdminAccesses.map((access) => access.userId),
    );
    const impactedNames = accessChanges
      .map((change) => {
        const user = change.userName || change.userEmail || change.userId;
        const role = change.roleName || change.roleCode;
        return `${user} (${role})`;
      })
      .join(', ');

    await NotificationService.createRequestNotification({
      companyId,
      type: 'MODIFICATION',
      name: 'Organization access updated',
      message: `System added ${accessChanges.length} user role access(es) for new organization node ${params.nodeName} (${params.nodePath}). Impacted: ${impactedNames}.`,
      referenceType: 'ORG',
      referenceId: params.orgReqId,
      referenceName: params.nodeName,
      createdBy: params.createdBy,
      recipientUserIds,
      isPending: false,
    });
  }

  private static async notifyOrgAccessRemoval(params: {
    companyId: string;
    orgReqId: string;
    nodeName: string;
    nodePath: string;
    createdBy: string;
    recipientUserIds: string[];
  }) {
    const recipientUserIds = NotificationService.mergeRecipientUserIds(
      params.recipientUserIds,
    );
    if (recipientUserIds.length === 0) return;

    await NotificationService.createRequestNotification({
      companyId: params.companyId,
      type: 'INACTIVE',
      name: 'Organization access removed',
      message: `Your access to organization ${params.nodeName} (${params.nodePath}) was removed because the organization was inactivated.`,
      referenceType: 'ORG',
      referenceId: params.orgReqId,
      referenceName: params.nodePath,
      createdBy: params.createdBy,
      recipientUserIds,
      requiredRecipientUserIds: recipientUserIds,
      isPending: false,
    });
  }

  private static async notifyPendingUserAccessRemoved(params: {
    companyId: string;
    orgReqId: string;
    createdBy: string;
    nodeName: string;
    nodePath: string;
    changes: PendingUserAccessRemovalNotification[];
  }) {
    if (params.changes.length === 0) return;

    const corpAdminUserIds = await NotificationService.getCorpAdminUserIds(
      params.companyId,
    );

    for (const change of params.changes) {
      const permissionSummary = change.removedPermissions
        .slice(0, 5)
        .map(
          (permission) =>
            `${permission.roleName} at ${permission.nodeName} (${permission.nodePath})`,
        )
        .join(', ');
      const recipientUserIds = NotificationService.mergeRecipientUserIds(
        change.initiatorId,
        change.eligibleApprovers,
        corpAdminUserIds,
      );

      await NotificationService.createRequestNotification({
        companyId: params.companyId,
        type: 'MODIFICATION',
        name: 'Pending user access removed',
        message: `Secondary access was removed from pending user request for ${change.targetUserName} because organization ${params.nodeName} (${params.nodePath}) was inactivated. Removed: ${permissionSummary}.`,
        referenceType: 'USER',
        referenceId: change.requestId,
        referenceName: change.targetUserEmail || change.targetUserName,
        createdBy: params.createdBy,
        recipientUserIds,
        requiredRecipientUserIds: NotificationService.mergeRecipientUserIds(
          change.initiatorId,
          change.eligibleApprovers,
        ),
        includeCreatedBy: true,
        isPending: false,
      });
    }
  }

  private static async notifyPendingWorkflowDeleted(params: {
    companyId: string;
    createdBy: string;
    nodeName: string;
    nodePath: string;
    changes: PendingWorkflowDeletionNotification[];
  }) {
    if (params.changes.length === 0) return;

    const corpAdminUserIds = await NotificationService.getCorpAdminUserIds(
      params.companyId,
    );

    for (const change of params.changes) {
      const recipientUserIds = NotificationService.mergeRecipientUserIds(
        change.initiatorId,
        change.eligibleApprovers,
        corpAdminUserIds,
      );

      await NotificationService.createRequestNotification({
        companyId: params.companyId,
        type: 'AUTO_DELETE',
        name: 'Pending workflow request deleted',
        message: `Pending workflow request ${change.workflowName} was rejected because organization ${params.nodeName} (${params.nodePath}) was inactivated.`,
        referenceType: 'WORKFLOW',
        referenceId: change.requestId,
        referenceName: change.workflowName,
        createdBy: params.createdBy,
        recipientUserIds,
        requiredRecipientUserIds: NotificationService.mergeRecipientUserIds(
          change.initiatorId,
          change.eligibleApprovers,
        ),
        includeCreatedBy: true,
        isPending: false,
      });
    }
  }

  private static pathsOverlap(left: string, right: string) {
    return (
      left === right ||
      left.startsWith(`${right}.`) ||
      right.startsWith(`${left}.`)
    );
  }

  private static pathWithinSubtree(candidatePath: string, subtreePath: string) {
    return (
      candidatePath === subtreePath ||
      candidatePath.startsWith(`${subtreePath}.`)
    );
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

    if (!companyId || reqTable !== 'org_structure_req') {
      return approverReqIds;
    }

    const initiatedReqIds = (
      await prisma.orgStructureReq.findMany({
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

  private static toNodeSnapshot(node: any): OrgNodeSnapshot {
    return {
      newNodeName: node.nodeName,
      nodeType: node.nodeType,
      nodePath: node.nodePath,
      parentNode: node.parent
        ? {
            nodeName: node.parent.nodeName,
            nodePath: node.parent.nodePath,
          }
        : {
            nodeName: 'ROOT',
            nodePath: 'ROOT',
          },
      status: node.status || 'ACTIVE',
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
          { role: { subCategory: 'ORG_STR', modify: true } },
        ],
      },
    });

    if (!access) {
      throw new AppError(
        'Access Denied: UPDATE permission is required for organization modifications',
        403,
      );
    }
  }

  private static async assertNoPendingHierarchyConflict(
    companyId: string,
    node: { nodePath: string; nodeName?: string },
  ) {
    const pendingRequests = await prisma.orgStructureReq.findMany({
      where: { companyId, status: 'PENDING' },
      include: {
        orgHistories: { where: { event: 'INITIATE' }, include: { user: true } },
      },
    });

    for (const request of pendingRequests) {
      const data = request.data as any;
      const targetNodePath =
        data?.targetNodePath || data?.currentData?.nodePath;
      const pendingNodePath =
        data?.nodePath ||
        (data?.parentNode?.nodePath && data?.newNodeName
          ? `${data.parentNode.nodePath}.${OrgStructureDbController.pathSegment(data.newNodeName)}`
          : null);
      const affectedPaths = [targetNodePath, pendingNodePath].filter(
        (path): path is string => typeof path === 'string',
      );

      if (
        affectedPaths.some((path) =>
          OrgStructureDbController.pathsOverlap(path, node.nodePath),
        )
      ) {
        const initiator = request.orgHistories?.[0]?.user;
        const initiatedAt =
          request.orgHistories?.[0]?.createdAt || request.createdAt;
        const pendingTitle =
          data?.newNodeName || data?.targetNodePath || request.id;
        throw new AppError(
          `Cannot inactivate node '${node.nodeName || node.nodePath}'. There is an active pending approval request '${pendingTitle}' initiated by ${initiator?.name || 'Unknown'} - ${initiator?.email || 'unknown'} on ${OrgStructureDbController.formatConflictDate(initiatedAt)}. Please resolve or reject the pending request first.`,
          400,
        );
      }
    }
  }

  private static async assertNoPendingInitiationConflict(
    companyId: string,
    node: { nodePath: string; nodeName?: string },
  ) {
    if (!node.nodePath) return;

    const pendingRequests = await prisma.orgStructureReq.findMany({
      where: { companyId, status: 'PENDING' },
      include: {
        orgHistories: { where: { event: 'INITIATE' }, include: { user: true } },
      },
    });
    const effectivePendingIds =
      await OrgStructureDbController.filterEffectivelyPendingRequestIds(
        'org_structure_req',
        pendingRequests.map((request) => request.id),
      );

    for (const request of pendingRequests) {
      if (!effectivePendingIds.has(request.id)) continue;

      const data = request.data as any;
      const pendingNodePath = OrgStructureDbController.resolveRequestedNodePath(
        data,
        OrgStructureDbController.extractOrgTargetPath(data),
      );

      if (pendingNodePath !== node.nodePath) continue;

      const initiator = request.orgHistories?.[0]?.user;
      const initiatedAt =
        request.orgHistories?.[0]?.createdAt || request.createdAt;
      const pendingTitle =
        data?.newNodeName || data?.nodeName || pendingNodePath;

      throw new AppError(
        `Cannot initiate organization '${node.nodeName || node.nodePath}'. A pending request for the same organization already exists as '${pendingTitle}', initiated by ${initiator?.name || 'Unknown'} - ${initiator?.email || 'unknown'} on ${OrgStructureDbController.formatConflictDate(initiatedAt)}. Please resolve or reject the pending request first.`,
        400,
      );
    }
  }

  private static async assertSelectedApprovalWorkflowNotPendingModification(
    companyId: string,
    levelsHash?: string | null,
  ) {
    const selectedWorkflow = await prisma.workflow.findFirst({
      where: {
        companyId,
        module: 'SYSTEM_ACCESS',
        subModule: 'ORG_STR',
        status: 'ACTIVE',
        ...(levelsHash ? { levelsHash } : { name: { contains: 'DEFAULT' } }),
      },
      orderBy: levelsHash ? undefined : { createdAt: 'desc' },
      include: { orgStructure: { select: { nodePath: true } } },
    });
    if (!selectedWorkflow) return;

    const pendingRequests = await prisma.workflowReq.findMany({
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
      await OrgStructureDbController.filterEffectivelyPendingRequestIds(
        'workflow_req',
        pendingRequests.map((request) => request.id),
      );
    const blocking = pendingRequests.find((request: any) => {
      if (!effectiveIds.has(request.id)) return false;
      const target = (request.data as any)?.target || {};
      return (
        target?.module === selectedWorkflow.module &&
        target?.subModule === selectedWorkflow.subModule &&
        target?.nodePath === selectedWorkflow.orgStructure?.nodePath &&
        target?.levelsHash === selectedWorkflow.levelsHash
      );
    });
    if (!blocking) return;

    const h = blocking.workflowHistories?.[0];
    throw new AppError(
      `Selected approval workflow '${selectedWorkflow.name}' has a pending ${blocking.type} request initiated by ${h?.user?.name || 'Unknown'} - ${h?.user?.email || 'unknown'} on ${OrgStructureDbController.formatConflictDate(h?.createdAt || blocking.createdAt)}. Please resolve that workflow request first.`,
      409,
    );
  }

  private static async getSubtreeNodes(
    client: any,
    companyId: string,
    nodePath: string,
  ) {
    return client.orgStructure.findMany({
      where: {
        companyId,
        status: 'ACTIVE',
        OR: [{ nodePath }, { nodePath: { startsWith: `${nodePath}.` } }],
      },
      orderBy: { nodePath: 'asc' },
    });
  }

  private static async getOrgInactivationNotification(
    client: any,
    companyId: string,
    nodePath: string,
  ): Promise<OrgInactivationNotification> {
    const subtreeNodes = await OrgStructureDbController.getSubtreeNodes(
      client,
      companyId,
      nodePath,
    );
    const subtreeIds = subtreeNodes.map((node: any) => node.id);

    if (subtreeIds.length === 0) {
      return {
        nodeName: nodePath,
        nodePath,
        accessUserIds: [],
        userNames: [],
        users: [],
        workflowCount: 0,
        workflowNames: [],
        workflows: [],
      };
    }

    const workflowWhere = {
      companyId,
      nodeId: { in: subtreeIds },
      status: 'ACTIVE',
    };

    const [accessRows, workflows] = await Promise.all([
      client.userAccess.findMany({
        where: {
          companyId,
          nodeId: { in: subtreeIds },
        },
        select: {
          userId: true,
          user: {
            select: { name: true, email: true },
          },
        },
      }),
      client.workflow.findMany({
        where: workflowWhere,
        select: { name: true, alias: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const accessUserIds = Array.from(
      new Set(
        accessRows
          .map((row: any) => row.userId)
          .filter(
            (userId: unknown): userId is string =>
              typeof userId === 'string' && userId.trim().length > 0,
          )
          .map((userId: string) => userId.trim()),
      ),
    ) as string[];

    const userNames = Array.from(
      new Set(
        accessRows
          .map((row: any) => row.user?.name)
          .filter(
            (name: unknown): name is string =>
              typeof name === 'string' && name.trim().length > 0,
          )
          .map((name: string) => name.trim()),
      ),
    ).sort() as string[];

    const users = Array.from(
      new Map(
        accessRows
          .map((row: any) => {
            const name =
              typeof row.user?.name === 'string' ? row.user.name.trim() : '';
            if (!name) return null;
            const email =
              typeof row.user?.email === 'string' && row.user.email.trim()
                ? row.user.email.trim()
                : null;
            return [
              `${name.toLowerCase()}::${(email || '').toLowerCase()}`,
              { name, email },
            ];
          })
          .filter(Boolean) as Array<
          [string, { name: string; email: string | null }]
        >,
      ).values(),
    ).sort((left, right) => left.name.localeCompare(right.name));

    const workflowNames = Array.from(
      new Set(
        workflows
          .map((workflow: any) => workflow.name)
          .filter(
            (name: unknown): name is string =>
              typeof name === 'string' && name.trim().length > 0,
          )
          .map((name: string) => name.trim()),
      ),
    ).sort() as string[];

    const workflowSummaries = Array.from(
      new Map(
        workflows
          .map((workflow: any) => {
            const workflowName =
              typeof workflow.name === 'string' ? workflow.name.trim() : '';
            if (!workflowName) return null;
            const alias =
              typeof workflow.alias === 'string' && workflow.alias.trim()
                ? workflow.alias.trim()
                : null;
            return [
              `${workflowName.toLowerCase()}::${(alias || '').toLowerCase()}`,
              { workflowName, alias },
            ];
          })
          .filter(Boolean) as Array<
          [string, { workflowName: string; alias: string | null }]
        >,
      ).values(),
    ).sort((left, right) =>
      left.workflowName.localeCompare(right.workflowName),
    );

    return {
      nodeName: subtreeNodes[0]?.nodeName || nodePath,
      nodePath,
      accessUserIds,
      userNames,
      users,
      workflowCount: workflowNames.length,
      workflowNames,
      workflows: workflowSummaries,
    };
  }

  private static async assertNoPrimaryAccessInSubtree(
    client: any,
    companyId: string,
    nodePath: string,
    nodeName?: string,
  ) {
    const nodes = await OrgStructureDbController.getSubtreeNodes(
      client,
      companyId,
      nodePath,
    );
    const primaryAccesses = await client.userAccess.findMany({
      where: {
        companyId,
        nodeId: { in: nodes.map((node: any) => node.id) },
        accessType: 'PRIMARY',
      },
      include: { user: { select: { email: true } } },
    });

    if (primaryAccesses.length > 0) {
      const emails = primaryAccesses
        .map((row: any) => row.user?.email)
        .filter((email: string | null | undefined): email is string =>
          Boolean(email),
        );
      const top = emails
        .slice(0, 10)
        .map((email: string) => `- ${email}`)
        .join('\n');
      const remaining = Math.max(emails.length - 10, 0);
      const remainingLine =
        remaining > 0 ? `\nand ${remaining} other user(s)...` : '';
      throw new AppError(
        `Cannot inactivate node '${nodeName || nodePath}' because it (or its sub-departments) currently has ${primaryAccesses.length} active primary users. Please reassign the following users to a different primary node before deactivating:\n${top}${remainingLine}`,
        400,
      );
    }
  }

  private static async assertNoActiveChildNodes(
    client: any,
    companyId: string,
    nodePath: string,
    nodeName?: string,
  ) {
    const children = await client.orgStructure.findMany({
      where: {
        companyId,
        status: 'ACTIVE',
        nodePath: { startsWith: `${nodePath}.` },
      },
      select: { nodeName: true },
      take: 6,
    });
    if (children.length > 0) {
      const childCount = await client.orgStructure.count({
        where: {
          companyId,
          status: 'ACTIVE',
          nodePath: { startsWith: `${nodePath}.` },
        },
      });
      const names = children
        .slice(0, 5)
        .map((child: any) => child.nodeName)
        .join(', ');
      throw new AppError(
        `Cannot inactivate node '${nodeName || nodePath}' because it contains ${childCount} active sub-departments. You must first inactivate the following child nodes: ${names}.`,
        400,
      );
    }
  }

  private static async createModificationRequest(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const {
        initiatorId,
        companyId,
        targetNodePath,
        levelsHash,
        remarks,
        data = {},
      } = req.body;

      if (!initiatorId || !companyId) {
        throw new AppError('initiatorId and companyId are required', 400);
      }
      await OrgStructureDbController.validateModificationPermission(
        initiatorId,
        companyId,
      );
      await OrgStructureDbController.assertSelectedApprovalWorkflowNotPendingModification(
        companyId,
        levelsHash || null,
      );

      if (!targetNodePath) {
        throw new AppError('Target node path is required', 400);
      }
      if (data.status !== 'INACTIVE') {
        throw new AppError(
          'Only inactive organization requests are supported; inactive nodes cannot be reactivated',
          400,
        );
      }

      const node = await prisma.orgStructure.findUnique({
        where: { nodePath: targetNodePath },
        include: { parent: true },
      });
      if (!node || node.companyId !== companyId) {
        throw new AppError('Organization node not found', 404);
      }
      if (node.nodeType === 'ROOT') {
        throw new AppError('Root organization node cannot be modified', 400);
      }
      if (node.status !== 'ACTIVE') {
        throw new AppError(
          'Inactive organization nodes cannot be modified or reactivated',
          400,
        );
      }

      await OrgStructureDbController.assertNoPendingHierarchyConflict(
        companyId,
        node,
      );
      await OrgStructureDbController.assertNoActiveChildNodes(
        prisma as any,
        companyId,
        node.nodePath,
        node.nodeName,
      );
      const oldData = {
        status: node.status || 'ACTIVE',
      };
      const impact = 'INACTIVE';
      await OrgStructureDbController.assertNoPrimaryAccessInSubtree(
        prisma as any,
        companyId,
        node.nodePath,
        node.nodeName,
      );
      await OrgStructureDbController.assertNoPendingPrimaryAccessRequestsInSubtree(
        prisma as any,
        {
          companyId,
          nodePath: node.nodePath,
          nodeName: node.nodeName,
        },
      );

      const impactSummaryNotification =
        await OrgStructureDbController.getOrgInactivationNotification(
          prisma as any,
          companyId,
          node.nodePath,
        );

      const requestData = {
        targetNodePath,
        ...data,
        impactSummary: OrgStructureDbController.buildImpactSummary(
          impactSummaryNotification.users,
          impactSummaryNotification.workflows,
        ),
      };
      let notificationRecipients: string[] = [];
      const request = await prisma.$transaction(async (tx) => {
        const requestRecord = await tx.orgStructureReq.create({
          data: {
            companyId,
            type: 'UPDATE',
            impact,
            initiatorId,
            data: requestData as any,
            oldData: oldData as any,
            remarks: remarks || null,
          },
        });
        const workflow = await WorkflowApproverUtil.resolveAndCreateApprovers(
          tx,
          {
            levelsHash: levelsHash || null,
            module: 'SYSTEM_ACCESS',
            subModule: 'ORG_STR',
            companyId,
            nodeId: node.id,
            initiatorId,
            reqId: requestRecord.id,
            reqTable: 'org_structure_req',
          },
        );
        notificationRecipients = workflow.currentLevelApprovers;
        await tx.orgStructureReq.update({
          where: { id: requestRecord.id },
          data: {
            workflowId: workflow.workflowId,
          },
        });
        await tx.orgHistory.create({
          data: {
            companyId,
            event: 'INITIATE',
            eventUserId: initiatorId,
            orgReqId: requestRecord.id,
            remarks: remarks || null,
          },
        });
        return requestRecord;
      });

      const modificationNotification =
        OrgStructureDbController.getOrgNotificationContent(
          'UPDATE',
          'initiated',
          targetNodePath,
        );
      const corpAdminUserIds =
        await NotificationService.getCorpAdminUserIds(companyId);
      const initiatorReportingManagerUserIds =
        await NotificationService.getReportingManagerUserIds(
          companyId,
          initiatorId,
          'ORG_STR',
        );
      await NotificationService.createRequestNotification({
        companyId,
        type: OrgStructureDbController.getOrgNotificationType(
          'UPDATE',
          'PENDING',
        ),
        name: modificationNotification.name,
        message: modificationNotification.message,
        referenceType: 'ORG',
        referenceId: request.id,
        referenceName: targetNodePath,
        createdBy: initiatorId,
        recipientUserIds: NotificationService.mergeRecipientUserIds(
          notificationRecipients,
          initiatorReportingManagerUserIds,
          corpAdminUserIds,
        ),
        includeCreatedBy: true,
      });
      res.status(201).json(request);
    } catch (error) {
      const initiatorId = req.body?.initiatorId;
      const companyId = req.body?.companyId;
      const targetNodePath = req.body?.targetNodePath;
      if (typeof initiatorId === 'string' && typeof companyId === 'string') {
        await OrgStructureDbController.notifyConflict(
          companyId,
          initiatorId,
          error instanceof Error ? error.message : 'Unexpected error',
          String(targetNodePath || 'organization node'),
          NotificationService.mergeRecipientUserIds(
            req.body?.eligibleApprovers,
          ),
        );
      }
      next(error);
    }
  }

  private static async applyApprovedModification(
    tx: any,
    request: any,
    notificationState?: {
      inactivation: OrgInactivationNotification | null;
      autoDeletedWorkflows?: OrgAutoDeletedWorkflowNotification[];
      pendingUserAccessRemovals?: PendingUserAccessRemovalNotification[];
      pendingWorkflowDeletions?: PendingWorkflowDeletionNotification[];
    },
    actorId?: string,
  ) {
    const requestData = request.data as any;
    const oldData = (request.oldData || requestData.oldData) as {
      status?: OrgNodeStatus;
    };
    const targetNodePath = requestData.targetNodePath || requestData.nodePath;
    const proposedStatus = requestData.status;
    if (
      request.impact !== 'INACTIVE' ||
      oldData?.status !== 'ACTIVE' ||
      proposedStatus !== 'INACTIVE'
    ) {
      throw new AppError(
        'Only one-way organization deactivation requests can be approved',
        400,
      );
    }

    const node = await tx.orgStructure.findUnique({
      where: { nodePath: targetNodePath },
    });

    if (!node || node.companyId !== request.companyId) {
      throw new AppError('Organization node not found', 404);
    }
    if (node.status !== 'ACTIVE') {
      throw new AppError(
        'Inactive organization nodes cannot be modified or reactivated',
        400,
      );
    }
    await OrgStructureDbController.assertNoPrimaryAccessInSubtree(
      tx,
      request.companyId,
      targetNodePath,
    );
    await OrgStructureDbController.assertNoPendingPrimaryAccessRequestsInSubtree(
      tx,
      {
        companyId: request.companyId,
        nodePath: targetNodePath,
        nodeName: node.nodeName,
      },
    );
    const pendingWorkflowDeletions =
      await OrgStructureDbController.rejectPendingWorkflowRequestsForOrgInactivation(
        tx,
        {
          companyId: request.companyId,
          nodePath: targetNodePath,
          nodeName: node.nodeName,
          actorId: actorId || undefined,
        },
      );

    const subtree = await OrgStructureDbController.getSubtreeNodes(
      tx,
      request.companyId,
      targetNodePath,
    );
    const subtreeIds = subtree.map((subtreeNode: any) => subtreeNode.id);
    const autoDeletedWorkflowRows = await tx.workflow.findMany({
      where: {
        companyId: request.companyId,
        nodeId: { in: subtreeIds },
        status: { not: 'ARCHIVE' },
      },
      select: {
        id: true,
        name: true,
        alias: true,
        module: true,
        subModule: true,
        type: true,
        workflowReqIds: true,
        orgStructure: {
          select: {
            nodeName: true,
            nodePath: true,
            nodeType: true,
          },
        },
      },
    });
    const pendingUserAccessRemovals =
      await OrgStructureDbController.removePendingSecondaryAccessRequestsForOrgInactivation(
        tx,
        {
          companyId: request.companyId,
          nodePath: targetNodePath,
        },
      );
    if (notificationState) {
      notificationState.inactivation =
        await OrgStructureDbController.getOrgInactivationNotification(
          tx,
          request.companyId,
          targetNodePath,
        );
      notificationState.autoDeletedWorkflows = autoDeletedWorkflowRows.map(
        (workflow: any) => ({
          workflowName: workflow.name,
          nodeName: workflow.orgStructure?.nodeName || targetNodePath,
          nodePath: workflow.orgStructure?.nodePath || targetNodePath,
          workflowReqIds: Array.isArray(workflow.workflowReqIds)
            ? workflow.workflowReqIds
            : [],
        }),
      );
      notificationState.pendingUserAccessRemovals = pendingUserAccessRemovals;
      notificationState.pendingWorkflowDeletions = pendingWorkflowDeletions;
    }
    const removedUserAccessRows = await tx.userAccess.findMany({
      where: { companyId: request.companyId, nodeId: { in: subtreeIds } },
      select: {
        userId: true,
        roleCode: true,
        nodeId: true,
        accessType: true,
        accessCategory: true,
        companyId: true,
        isGlobalAccess: true,
        user: {
          select: {
            name: true,
            email: true,
          },
        },
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
          },
        },
      },
    });
    await OrgStructureDbController.createAutoApprovedUserAccessAuditRows(tx, {
      companyId: request.companyId,
      actorId,
      type: 'AUTO_DELETE',
      impact: 'DOWNGRADE',
      remarks: `Auto deleted because organization node ${node.nodeName} (${targetNodePath}) was inactivated.`,
      entries: removedUserAccessRows.map((access: any) => ({
        userId: access.userId,
        userName: access.user?.name || null,
        userEmail: access.user?.email || null,
        roleCode: access.roleCode,
        roleName: access.role?.roleName || access.roleCode,
        roleCategory: access.role?.category || 'SYSTEM_ACCESS',
        roleSubCategory: access.role?.subCategory || 'USER_ACC',
        nodeId: access.nodeId,
        nodeName: access.orgStructure?.nodeName || targetNodePath,
        nodePath: access.orgStructure?.nodePath || targetNodePath,
        accessType: access.accessType || 'SECONDARY',
        accessCategory: access.accessCategory || 'NODE',
        companyId: access.companyId,
        isGlobalAccess: Boolean(access.isGlobalAccess),
      })),
    });
    await tx.userAccess.deleteMany({
      where: { companyId: request.companyId, nodeId: { in: subtreeIds } },
    });
    if (actorId) {
      const impactedUserIds: string[] = Array.from(
        new Set(
          removedUserAccessRows
            .map((access: any) => String(access.userId || '').trim())
            .filter(Boolean),
        ),
      );
      for (const userId of impactedUserIds) {
        await NotificationService.syncNotificationSettingsForUserAccess(tx, {
          companyId: request.companyId,
          userId,
          eventUserId: actorId,
          createReason:
            'Default notification setting created because access was granted.',
          removeReason:
            'Notification setting removed because node was inactivated.',
        });
      }
    }
    await tx.workflow.updateMany({
      where: {
        companyId: request.companyId,
        nodeId: { in: subtreeIds },
        status: { not: 'ARCHIVE' },
      },
      data: {
        status: 'ARCHIVE',
      },
    });
    if (actorId) {
      await Promise.all(
        autoDeletedWorkflowRows.map(async (workflow: any) => {
          const candidateRequestIds = Array.isArray(workflow.workflowReqIds)
            ? workflow.workflowReqIds.filter(
                (id: unknown): id is string => typeof id === 'string' && !!id,
              )
            : [];
          if (candidateRequestIds.length === 0) return;

          const workflowRequests = await tx.workflowReq.findMany({
            where: {
              companyId: request.companyId,
              id: { in: candidateRequestIds },
            },
            select: {
              id: true,
              type: true,
              createdAt: true,
              data: true,
            },
          });
          const requestId =
            workflowRequests.find(
              (workflowReq: any) =>
                workflowReq.type === 'AUTO_GENERATE' &&
                typeof (workflowReq.data as any)?.sourceWorkflowId === 'string',
            )?.id ||
            workflowRequests.sort((left: any, right: any) => {
              const leftTime = new Date(left.createdAt).getTime();
              const rightTime = new Date(right.createdAt).getTime();
              if (leftTime !== rightTime) return rightTime - leftTime;
              return String(right.id).localeCompare(String(left.id));
            })[0]?.id;
          if (!requestId) return;

          const remarks = `Auto deleted workflow ${workflow.name} (${workflow.orgStructure?.nodePath || targetNodePath}) because organization node ${node.nodeName} (${targetNodePath}) was inactivated.`;

          await tx.workflowReqHistory.create({
            data: {
              workflowReqId: requestId,
              companyId: request.companyId,
              event: 'AUTO_DELETE',
              eventUserId: actorId,
              remarks,
            },
          });
        }),
      );
    }
    await tx.orgStructure.updateMany({
      where: { id: { in: subtreeIds } },
      data: { status: 'INACTIVE' },
    });
  }

  // --- Internal Atomic Operations ---

  /**
   * Fetches a specific organization structure request by ID.
   */
  static async getOrgRequestById(req: Request, res: Response) {
    const { id, companyId } = req.body;
    const request = await prisma.orgStructureReq.findFirst({
      where: { id, companyId },
      include: { company: true },
    });
    res.json(request);
  }

  /**
   * Fetches an active organization node by its unique nodePath.
   */
  static async getOrgNodeByPath(req: Request, res: Response) {
    const { nodePath } = req.body;
    const node = await prisma.orgStructure.findFirst({
      where: { nodePath, status: 'ACTIVE' },
    });
    res.json(node);
  }

  /**
   * Fetches an active organization node by path and company context.
   */
  static async getOrgNodeByPathCompanyId(req: Request, res: Response) {
    const { nodePath, companyId } = req.body;

    const node = await prisma.orgStructure.findFirst({
      where: { nodePath, companyId, status: 'ACTIVE' },
    });
    res.json(node);
  }

  // --- Transactional Commit Operations ---

  /**
   * Processes the approval or rejection of an organization unit request.
   * Level-wise Approval Flow:
   * 1. Checks the current pending level from WorkflowApprover.
   * 2. Verifies the approver is in the current level's approversList.
   * 3. For APPROVE: marks level as APPROVED, only commits the node if all levels pass.
   * 4. For REJECT: marks all levels REJECTED.
   * 5. Logs level-wise events in OrgHistory.
   */
  static async updateOrgRequestStatus(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const {
        id,
        companyId,
        status, // 'approved' | 'rejected'
        approverId,
        remarks,
        newNodePath,
        newNodeName,
        nodeType,
        parentId,
      } = req.body;

      if (!id || !companyId || !status) {
        throw new Error('id, companyId and status are required');
      }
      let notificationCompanyId = '';
      let notificationRecipients: string[] = [];
      let notificationSubject = 'Organization request';
      let userAccessImpactNotification: any = null;
      const orgLifecycleNotification: {
        inactivation: OrgInactivationNotification | null;
        autoDeletedWorkflows: OrgAutoDeletedWorkflowNotification[];
        pendingUserAccessRemovals: PendingUserAccessRemovalNotification[];
        pendingWorkflowDeletions: PendingWorkflowDeletionNotification[];
      } = {
        inactivation: null,
        autoDeletedWorkflows: [],
        pendingUserAccessRemovals: [],
        pendingWorkflowDeletions: [],
      };
      let autoGeneratedWorkflowNotifications: Array<{
        workflowName: string;
        alias: string;
        module: string;
        subModule: string;
        workflowType: string;
        nodeName: string;
        nodePath: string;
        sourceWorkflowName: string;
        sourceNodeName: string;
        sourceNodePath: string;
      }> = [];

      // ── Check WorkflowApprover for level-wise authorization ──────────────
      const currentLevel = await WorkflowApproverUtil.getCurrentPendingLevel(
        id,
        'org_structure_req',
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
      }

      const result = await prisma.$transaction(async (tx) => {
        const request = await tx.orgStructureReq.findFirst({
          where: { id, companyId },
          include: { company: true },
        });

        if (!request) throw new Error('Request not found');
        if (request.status !== 'PENDING') {
          throw new AppError('Request is already processed', 400);
        }
        notificationCompanyId = request.companyId;
        notificationRecipients = request.eligibleApprovers || [];
        notificationSubject =
          (request.data as any)?.newNodeName || notificationSubject;

        // --- Prevent Self-Approval ---
        // Block the initiator from approving their own request.
        const initiatorLog = await prisma.orgHistory.findFirst({
          where: { orgReqId: id, event: 'INITIATE' },
        });
        if (initiatorLog && initiatorLog.eventUserId === approverId) {
          throw new AppError('Initiator cannot approve their own request', 403);
        }

        // --- Prevent Double Approval ---
        const alreadyApproved = await WorkflowApproverUtil.isAlreadyApproved(
          tx,
          id,
          'org_structure_req',
          approverId,
        );
        if (alreadyApproved) {
          throw new AppError(
            'You have already approved this request once',
            403,
          );
        }

        // Fallback: Verify with legacy eligibleApprovers if no WorkflowApprover rows
        if (!currentLevel) {
          if (
            request.eligibleApprovers &&
            request.eligibleApprovers.length > 0 &&
            !request.eligibleApprovers.includes(approverId)
          ) {
            throw new Error('Unauthorized to process this request');
          }
        }

        // --- REJECT FLOW ---
        const statusStr = status.toString().toUpperCase();
        if (statusStr === 'REJECTED' || statusStr === 'REJECT') {
          // Reject all remaining approval levels
          await WorkflowApproverUtil.rejectAllLevels(
            tx,
            id,
            'org_structure_req',
          );

          const updated = await tx.orgStructureReq.update({
            where: { id },
            data: {
              status: 'REJECTED',
              remarks,
            },
          });

          if (approverId) {
            await tx.orgHistory.create({
              data: {
                companyId: request.companyId,
                event: 'REJECTED',
                eventUserId: approverId,
                orgReqId: id,
                level: currentLevel?.level || null,
                remarks: remarks,
              },
            });
          }

          return { ...updated, status: 'REJECTED' };
        }

        // --- APPROVE FLOW ---
        if (statusStr === 'APPROVED' || statusStr === 'APPROVE') {
          // ── Level-wise approval: mark current level as APPROVED ──────────
          let allLevelsApproved = true;
          const approvedLevel = currentLevel?.level || null;

          if (currentLevel) {
            const nextLevel = await WorkflowApproverUtil.approveLevel(
              tx,
              id,
              'org_structure_req',
              currentLevel.level,
              approverId,
            );
            if (nextLevel) {
              allLevelsApproved = false;
              notificationRecipients = Array.isArray(nextLevel.approversList)
                ? (nextLevel.approversList as string[])
                : notificationRecipients;
            }
          }

          // Log level-wise APPROVED event in history
          await tx.orgHistory.create({
            data: {
              companyId: request.companyId,
              event: 'APPROVED',
              eventUserId: approverId,
              orgReqId: id,
              level: approvedLevel,
              remarks: remarks,
            },
          });

          // If NOT all levels approved, return early (partial approval)
          if (!allLevelsApproved) {
            return {
              id: request.id,
              status: 'PARTIAL_APPROVED',
              level: approvedLevel,
              type: request.type,
            };
          }

          if (request.type === 'UPDATE') {
            await OrgStructureDbController.applyApprovedModification(
              tx,
              request,
              orgLifecycleNotification,
              approverId,
            );
            const updated = await tx.orgStructureReq.update({
              where: { id },
              data: {
                status: 'APPROVED',
                remarks,
              },
            });

            return { ...updated, status: 'APPROVED' };
          }

          // ── All levels approved — proceed with node creation ─────────────
          if (!newNodePath || !newNodeName || !nodeType) {
            throw new Error('Missing node details for approval');
          }

          const resolvedNodePath =
            await OrgStructureDbController.resolveUniqueNodePath(
              tx,
              request.companyId,
              newNodePath,
            );

          // 1. Create the actual node in the production organization structure
          const newNode = await tx.orgStructure.create({
            data: {
              companyId: request.companyId,
              nodePath: resolvedNodePath,
              nodeName: newNodeName,
              nodeType: nodeType,
              parentId: parentId || null,
            },
          });

          autoGeneratedWorkflowNotifications =
            await OrgStructureDbController.autoGenerateChildWorkflows(tx, {
              companyId: request.companyId,
              parentNodeId: parentId || null,
              newNode,
              orgReqId: id,
              actorId: approverId,
            });

          const parentAccesses =
            await OrgStructureDbController.getPropagatingParentAccesses(
              tx,
              request.companyId,
              resolvedNodePath,
            );
          const newAccesses = OrgStructureDbController.buildPropagatedAccesses(
            parentAccesses,
            newNode.id,
            {
              nodeName: newNode.nodeName,
              nodePath: newNode.nodePath,
            },
          );

          if (newAccesses.length > 0) {
            await tx.userAccess.createMany({
              data: newAccesses.map(
                ({
                  userName,
                  userEmail,
                  roleName,
                  roleCategory,
                  roleSubCategory,
                  nodeName,
                  nodePath,
                  ...access
                }: any) => access,
              ),
              skipDuplicates: true,
            });
            await OrgStructureDbController.createAutoApprovedUserAccessAuditRows(
              tx,
              {
                companyId: request.companyId,
                actorId: approverId,
                type: 'AUTO_GENERATE',
                impact: 'UPGRADE',
                remarks: `Auto generated because organization node ${newNode.nodeName} (${newNode.nodePath}) was created.`,
                entries: newAccesses,
              },
            );
            const impactedUserIds: string[] = Array.from(
              new Set(
                newAccesses
                  .map((access: any) => String(access.userId || '').trim())
                  .filter(Boolean),
              ),
            );
            for (const userId of impactedUserIds) {
              await NotificationService.syncNotificationSettingsForUserAccess(
                tx,
                {
                  companyId: request.companyId,
                  userId,
                  eventUserId: approverId,
                  createReason:
                    'Default notification setting created because access was granted.',
                  removeReason:
                    'Notification setting removed because access was removed.',
                },
              );
            }
            userAccessImpactNotification = {
              nodeName: newNode.nodeName,
              nodePath: newNode.nodePath,
              accessChanges: newAccesses.map((access: any) => ({
                userId: access.userId,
                userName: access.userName,
                userEmail: access.userEmail,
                roleName: access.roleName,
                roleCode: access.roleCode,
              })),
            };
          }

          // 2. Update the onboarding request status
          const updated = await tx.orgStructureReq.update({
            where: { id },
            data: {
              status: 'APPROVED',
              impact: OrgStructureDbController.formatUserAccessImpact(
                newAccesses.length,
              ),
              data: {
                ...((request.data as any) || {}),
                nodePath: resolvedNodePath,
                impactSummary: OrgStructureDbController.buildImpactSummary(
                  Array.from(
                    new Map(
                      newAccesses
                        .map((access: any) => {
                          const name =
                            typeof access.userName === 'string'
                              ? access.userName.trim()
                              : '';
                          if (!name) return null;
                          const email =
                            typeof access.userEmail === 'string' &&
                            access.userEmail.trim()
                              ? access.userEmail.trim()
                              : null;
                          return [
                            `${name.toLowerCase()}::${(email || '').toLowerCase()}`,
                            { name, email },
                          ];
                        })
                        .filter(Boolean) as Array<
                        [string, { name: string; email: string | null }]
                      >,
                    ).values(),
                  ).sort((left, right) => left.name.localeCompare(right.name)),
                  Array.from(
                    new Map(
                      autoGeneratedWorkflowNotifications
                        .map((workflow: any) => {
                          const workflowName =
                            typeof workflow.workflowName === 'string'
                              ? workflow.workflowName.trim()
                              : '';
                          if (!workflowName) return null;
                          const alias =
                            typeof workflow.alias === 'string' &&
                            workflow.alias.trim()
                              ? workflow.alias.trim()
                              : null;
                          return [
                            `${workflowName.toLowerCase()}::${(alias || '').toLowerCase()}`,
                            { workflowName, alias },
                          ];
                        })
                        .filter(Boolean) as Array<
                        [string, { workflowName: string; alias: string | null }]
                      >,
                    ).values(),
                  ).sort((left, right) =>
                    left.workflowName.localeCompare(right.workflowName),
                  ),
                ),
              } as any,
              remarks,
            },
          });

          return {
            ...updated,
            status: 'APPROVED',
            data: {
              ...(((updated as any).data || {}) as any),
              nodePath: resolvedNodePath,
            },
          };
        }

        throw new Error('Invalid status value');
      });

      const requestType = String(
        (result as any)?.type || 'INITIATE',
      ).toUpperCase();
      let message = 'Org structure request processed';
      if (result && result.status === 'PARTIAL_APPROVED') {
        message = `Org structure request approved at Level ${result.level}, pending remaining approval`;
        notificationRecipients =
          await NotificationService.getCurrentApproverIds(
            id,
            'org_structure_req',
            notificationRecipients,
          );
      } else if (result && result.status === 'APPROVED') {
        message =
          requestType === 'UPDATE'
            ? 'Org structure modification approved'
            : 'Org structure request approved and node created';
      } else if (result && result.status === 'REJECTED') {
        message = `Org structure ${requestType.toLowerCase()} request rejected`;
      }
      const isPartialApproval = result?.status === 'PARTIAL_APPROVED';

      if (notificationCompanyId) {
        const requestInitiatorId =
          await NotificationService.getRequestInitiatorId(
            id,
            'org_structure_req',
          );
        const requestInitiatorReportingManagerUserIds =
          await NotificationService.getRequestInitiatorReportingManagerIds(
            notificationCompanyId,
            id,
            'org_structure_req',
          );
        const inactivationNotification =
          orgLifecycleNotification.inactivation || null;
        const isOrgInactivation = Boolean(
          result?.status === 'APPROVED' &&
          requestType === 'UPDATE' &&
          String((result as any)?.impact || '').toUpperCase() === 'INACTIVE' &&
          inactivationNotification,
        );
        const notificationRecipientUserIds = isPartialApproval
          ? NotificationService.mergeRecipientUserIds(notificationRecipients)
          : NotificationService.mergeRecipientUserIds(
              notificationRecipients,
              requestInitiatorId,
              requestInitiatorReportingManagerUserIds,
            );
        const orgNotificationContent = isOrgInactivation
          ? {
              name: 'Organization Removed',
              message: `Organization ${inactivationNotification?.nodeName || notificationSubject} (${inactivationNotification?.nodePath || notificationSubject}) was inactivated. ${inactivationNotification?.workflowCount || 0} workflow(s) were deleted ${inactivationNotification?.workflowNames && inactivationNotification.workflowNames.length > 0 ? `: ${inactivationNotification.workflowNames.join(', ')}` : ''}. Access was removed for ${inactivationNotification?.accessUserIds.length || 0} user(s).`,
            }
          : isPartialApproval
            ? OrgStructureDbController.getOrgPendingApprovalNotificationContent(
                result?.type || requestType,
                notificationSubject,
              )
            : requestType === 'UPDATE' && result?.status
              ? OrgStructureDbController.getOrgNotificationContent(
                  requestType,
                  result.status === 'REJECTED' ? 'rejected' : 'approved',
                  notificationSubject,
                )
              : null;
        const corpAdminUserIds = await NotificationService.getCorpAdminUserIds(
          notificationCompanyId,
        );
        const notificationType = isOrgInactivation
          ? 'INACTIVE'
          : OrgStructureDbController.getOrgNotificationType(
              result?.type || requestType,
              result?.status,
            );

        await NotificationService.createRequestNotification({
          companyId: notificationCompanyId,
          type: notificationType,
          ...(orgNotificationContent || {}),
          referenceType: 'ORG',
          referenceId: id,
          referenceName:
            inactivationNotification?.nodePath || notificationSubject,
          createdBy: approverId,
          recipientUserIds: NotificationService.mergeRecipientUserIds(
            notificationRecipientUserIds,
            ...(isPartialApproval ? [] : [corpAdminUserIds]),
          ),
          requiredRecipientUserIds: isPartialApproval
            ? NotificationService.mergeRecipientUserIds(notificationRecipients)
            : NotificationService.mergeRecipientUserIds(requestInitiatorId),
          includeCreatedBy: true,
          isPending: isPartialApproval,
        });

        if (
          isOrgInactivation &&
          approverId &&
          inactivationNotification?.accessUserIds.length
        ) {
          await OrgStructureDbController.notifyOrgAccessRemoval({
            companyId: notificationCompanyId,
            orgReqId: id,
            nodeName: inactivationNotification.nodeName || notificationSubject,
            nodePath: inactivationNotification.nodePath || notificationSubject,
            createdBy: approverId,
            recipientUserIds: inactivationNotification.accessUserIds,
          });
        }
      }

      if (
        notificationCompanyId &&
        result?.status === 'APPROVED' &&
        result?.type !== 'UPDATE' &&
        userAccessImpactNotification
      ) {
        await OrgStructureDbController.notifyUserAccessImpact({
          companyId: notificationCompanyId,
          orgReqId: id,
          nodeName: userAccessImpactNotification.nodeName,
          nodePath: userAccessImpactNotification.nodePath,
          createdBy: approverId,
          accessChanges: userAccessImpactNotification.accessChanges,
        });
      }

      if (
        notificationCompanyId &&
        result?.status === 'APPROVED' &&
        result?.type !== 'UPDATE' &&
        autoGeneratedWorkflowNotifications.length > 0
      ) {
        await OrgStructureDbController.notifyAutoGeneratedWorkflows({
          companyId: notificationCompanyId,
          orgReqId: id,
          createdBy: approverId,
          generatedWorkflows: autoGeneratedWorkflowNotifications,
        });
      }

      if (
        notificationCompanyId &&
        result?.status === 'APPROVED' &&
        result?.type === 'UPDATE' &&
        String((result as any)?.impact || '').toUpperCase() === 'INACTIVE' &&
        orgLifecycleNotification.autoDeletedWorkflows &&
        orgLifecycleNotification.autoDeletedWorkflows.length > 0
      ) {
        await OrgStructureDbController.notifyAutoDeletedWorkflows({
          companyId: notificationCompanyId,
          orgReqId: id,
          createdBy: approverId,
          deletedWorkflows: orgLifecycleNotification.autoDeletedWorkflows,
        });
      }

      if (
        notificationCompanyId &&
        result?.status === 'APPROVED' &&
        result?.type === 'UPDATE' &&
        String((result as any)?.impact || '').toUpperCase() === 'INACTIVE' &&
        orgLifecycleNotification.pendingUserAccessRemovals.length > 0
      ) {
        const inactivationNotification =
          orgLifecycleNotification.inactivation || null;
        await OrgStructureDbController.notifyPendingUserAccessRemoved({
          companyId: notificationCompanyId,
          orgReqId: id,
          createdBy: approverId,
          nodeName: inactivationNotification?.nodeName || notificationSubject,
          nodePath: inactivationNotification?.nodePath || notificationSubject,
          changes: orgLifecycleNotification.pendingUserAccessRemovals,
        });
      }

      if (
        notificationCompanyId &&
        result?.status === 'APPROVED' &&
        result?.type === 'UPDATE' &&
        String((result as any)?.impact || '').toUpperCase() === 'INACTIVE' &&
        orgLifecycleNotification.pendingWorkflowDeletions.length > 0
      ) {
        const inactivationNotification =
          orgLifecycleNotification.inactivation || null;
        await OrgStructureDbController.notifyPendingWorkflowDeleted({
          companyId: notificationCompanyId,
          createdBy: approverId,
          nodeName: inactivationNotification?.nodeName || notificationSubject,
          nodePath: inactivationNotification?.nodePath || notificationSubject,
          changes: orgLifecycleNotification.pendingWorkflowDeletions,
        });
      }

      res.status(200).json({
        success: true,
        message,
        data: result,
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
      if (
        typeof initiatorId === 'string' &&
        typeof resolvedCompanyId === 'string'
      ) {
        const requestId = req.body?.id;
        const requestApproverIds =
          typeof requestId === 'string'
            ? await NotificationService.getRequestApproverIds(
                requestId,
                'org_structure_req',
              )
            : NotificationService.mergeRecipientUserIds(
                req.body?.eligibleApprovers,
              );
        await OrgStructureDbController.notifyConflict(
          resolvedCompanyId,
          initiatorId,
          error instanceof Error ? error.message : 'Unexpected error',
          String(
            req.body?.targetNodePath ||
              req.body?.data?.newNodeName ||
              'organization',
          ),
          requestApproverIds,
        );
      }
      next(error);
    }
  }

  /**
   * Initiates a request to add a new organization unit.
   * 1. Creates the OrgStructureReq record.
   * 2. Resolves the workflow (explicit or default for ORG_STR section).
   * 3. Builds WorkflowApprover rows for each approval level.
   * 4. Logs an 'INITIATE' event in OrgHistory.
   */
  static async initiateRequest(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      if (String(req.body?.type ?? 'INITIATE').toUpperCase() === 'UPDATE') {
        return OrgStructureDbController.createModificationRequest(
          req,
          res,
          next,
        );
      }

      const {
        initiatorId,
        companyCode,
        companyId,
        levelsHash,
        type: _type,
        ...rest
      } = req.body;
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

      // Fetch all global access users for this company to ensure they are in the master eligible list
      const globalUsers = await WorkflowApproverUtil.getGlobalAccessUserIds(
        prisma as any,
        resolvedCompanyId,
        'ORG_STR',
      );

      // Master eligible list includes both configured and global approvers.
      // Initiator is excluded from all active approval lists.
      const masterEligible = new Set([
        ...(rest.eligibleApprovers || []),
        ...globalUsers,
      ]);
      rest.eligibleApprovers = Array.from(masterEligible).filter(
        (id) => id !== initiatorId,
      );
      let notificationRecipients = rest.eligibleApprovers;

      const request = await prisma.$transaction(async (tx) => {
        const reqData = rest.data || {};
        const requestedNodePath =
          await OrgStructureDbController.resolveUniqueRequestedNodePath(
            tx,
            resolvedCompanyId,
            reqData,
          );
        const propagatedAccessSummaries =
          await OrgStructureDbController.getPropagatedUserAccessSummaries(
            tx,
            resolvedCompanyId,
            requestedNodePath,
          );
        const autoGeneratedWorkflowSummaries =
          await OrgStructureDbController.getAutoGeneratedWorkflowTemplateSummaries(
            tx,
            resolvedCompanyId,
            reqData.parentNode?.nodePath,
          );
        const reqRecord = await tx.orgStructureReq.create({
          data: {
            ...rest,
            type: 'INITIATE',
            impact: OrgStructureDbController.formatUserAccessImpact(
              propagatedAccessSummaries.length,
            ),
            data: {
              ...(reqData || {}),
              nodePath: requestedNodePath || reqData?.nodePath || null,
              impactSummary: OrgStructureDbController.buildImpactSummary(
                propagatedAccessSummaries,
                autoGeneratedWorkflowSummaries,
              ),
            },
            initiatorId: initiatorId || null,
            companyId: resolvedCompanyId,
          },
          include: { company: true },
        });

        // ── Resolve workflow approvers and create WorkflowApprover rows ──────
        // Determine node for approver resolution from the request data
        let nodeId: string | null = null;

        // Use parent node if available, otherwise use root node
        if (reqData.parentNode?.nodePath) {
          const parentNode = await tx.orgStructure.findFirst({
            where: {
              nodePath: reqData.parentNode.nodePath,
              companyId: resolvedCompanyId,
            },
          });
          if (parentNode) nodeId = parentNode.id;
        }

        // Fallback to root node
        if (!nodeId) {
          const rootNode = await tx.orgStructure.findFirst({
            where: { companyId: resolvedCompanyId, nodeType: 'ROOT' },
          });
          if (rootNode) nodeId = rootNode.id;
        }

        if (nodeId && initiatorId) {
          const { workflowId: resolvedWorkflowId, currentLevelApprovers } =
            await WorkflowApproverUtil.resolveAndCreateApprovers(tx, {
              levelsHash: levelsHash || null,
              module: 'SYSTEM_ACCESS',
              subModule: 'ORG_STR',
              companyId: resolvedCompanyId,
              nodeId,
              initiatorId,
              reqId: reqRecord.id,
              reqTable: 'org_structure_req',
            });
          notificationRecipients = currentLevelApprovers;

          // Store the resolved workflowId in the request record
          await tx.orgStructureReq.update({
            where: { id: reqRecord.id },
            data: { workflowId: resolvedWorkflowId },
          });
        }

        await tx.orgHistory.create({
          data: {
            companyId: resolvedCompanyId,
            event: 'INITIATE',
            eventUserId: initiatorId,
            orgReqId: reqRecord.id,
          },
        });
        return reqRecord;
      });
      const initiatorReportingManagerUserIds =
        await NotificationService.getReportingManagerUserIds(
          resolvedCompanyId,
          initiatorId,
          'ORG_STR',
        );
      await NotificationService.createRequestNotification({
        companyId: resolvedCompanyId,
        type: 'INITIATE',
        referenceType: 'ORG',
        referenceId: request.id,
        referenceName: rest.data?.newNodeName,
        createdBy: initiatorId,
        recipientUserIds: NotificationService.mergeRecipientUserIds(
          notificationRecipients,
          initiatorReportingManagerUserIds,
          await NotificationService.getCorpAdminUserIds(resolvedCompanyId),
        ),
        includeCreatedBy: true,
      });
      res.status(201).json(request);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Validates the feasibility of a new organization node request.
   * - Checks if the parent node exists in production.
   * - Checks for duplicate PENDING requests for the same node name to prevent collision.
   */
  static async validateInitiation(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { companyCode, companyId, newNodeName, _nodeType, parentNode } =
        req.body;
      let resolvedCompanyId = companyId;

      if (!resolvedCompanyId) {
        if (!companyCode) {
          return res
            .status(400)
            .json({ error: 'companyCode or companyId is required' });
        }

        const company = await prisma.company.findUnique({
          where: { companyCode },
        });
        if (!company)
          return res.status(404).json({ error: 'Company not found' });
        resolvedCompanyId = company.id;
      }

      // 1. Verify Parent existence for hierarchical integrity
      if (parentNode && parentNode.nodePath) {
        const parentRecord = await prisma.orgStructure.findFirst({
          where: {
            companyId: resolvedCompanyId,
            nodePath: parentNode.nodePath,
            nodeName: parentNode.nodeName,
            status: 'ACTIVE',
          },
        });
        if (!parentRecord) {
          return res.status(400).json({
            success: false,
            message: 'Parent node not found in organization structure',
          });
        }
      }

      const requestedNodePath =
        OrgStructureDbController.resolveRequestedNodePath({
          parentNode,
          newNodeName,
          nodePath: req.body?.nodePath,
        });
      if (requestedNodePath) {
        const resolvedNodePath =
          await OrgStructureDbController.resolveUniqueRequestedNodePath(
            prisma,
            resolvedCompanyId,
            {
              parentNode,
              newNodeName,
              nodePath: req.body?.nodePath,
            },
          );
        return res.status(200).json({
          success: true,
          nodePath: resolvedNodePath,
        });
      }

      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Retrieves the audit history for organization structure changes within a company.
   */
  static async fetchOrgHistory(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const {
        companyCode,
        companyId,
        nodeName,
        nodePath,
        userId: viewerUserId,
      } = req.body;
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

      let whereCondition: any = { companyId: resolvedCompanyId };
      let applyHistoryFilter = false;
      const normalizedNodeName = nodeName?.trim().toLowerCase() || null;
      let selectedNodeType: string | null = null;
      if (typeof nodePath === 'string' && nodePath.length > 0) {
        const selectedNode = await prisma.orgStructure.findFirst({
          where: { companyId: resolvedCompanyId, nodePath },
          select: { nodeType: true },
        });
        selectedNodeType = selectedNode?.nodeType || null;
      }
      const matchesNodeFilter = (data: any) => {
        if (!data) return false;
        const candidateNodeNames = [
          data?.newNodeName,
          data?.currentData?.nodeName,
        ]
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.toLowerCase());
        const derivedNodePath =
          typeof data?.parentNode?.nodePath === 'string' &&
          typeof data?.newNodeName === 'string'
            ? `${data.parentNode.nodePath}.${OrgStructureDbController.pathSegment(data.newNodeName)}`
            : null;
        const candidatePaths = [
          data?.targetNodePath,
          data?.currentData?.nodePath,
          data?.nodePath,
          derivedNodePath,
        ].filter((value): value is string => typeof value === 'string');
        const parentNodePath =
          typeof data?.parentNode?.nodePath === 'string'
            ? data.parentNode.nodePath
            : null;
        const hasPathSignals = candidatePaths.length > 0;
        const extractedNames = candidatePaths
          .map((p) => p.split('.').pop()?.toLowerCase())
          .filter((value): value is string => Boolean(value));
        const allCandidateNames = [...candidateNodeNames, ...extractedNames];
        const nodeNameMatches = normalizedNodeName
          ? allCandidateNames.includes(normalizedNodeName)
          : true;
        const nodePathMatches =
          typeof nodePath === 'string' && nodePath.length > 0
            ? hasPathSignals
              ? candidatePaths.some((path) => path === nodePath) ||
                (selectedNodeType === 'ROOT' && parentNodePath === nodePath)
              : nodeNameMatches
            : true;
        return nodeNameMatches && nodePathMatches;
      };

      if (nodeName || nodePath) {
        const matchingReqs = (
          await prisma.orgStructureReq.findMany({
            where: { companyId: resolvedCompanyId },
            select: { id: true, data: true, type: true },
          })
        ).filter((req) => matchesNodeFilter(req.data as any));

        const reqIds = matchingReqs.map((r) => r.id);
        if (reqIds.length > 0) {
          whereCondition.orgReqId = { in: reqIds };
        } else {
          applyHistoryFilter = true;
        }
      }

      let histories = await prisma.orgHistory.findMany({
        where: whereCondition,
        include: {
          user: {
            include: {
              userAccesses: {
                where: { companyId: resolvedCompanyId },
              },
            },
          },
          orgReq: true,
          company: { select: { companyCode: true, id: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (applyHistoryFilter) {
        histories = histories.filter((h) =>
          matchesNodeFilter(h.orgReq?.data as any),
        );
      }
      histories = histories.filter(
        (history) =>
          history.event !== 'AUTO_GENERATE' && history.event !== 'AUTO_DELETE',
      );

      // 1. Collect all unique request IDs to fetch their workflow approval status
      const reqIds = Array.from(
        new Set(histories.map((h) => h.orgReqId).filter(Boolean)),
      ) as string[];

      const workflowApprovers = await prisma.workflowApprover.findMany({
        where: { reqId: { in: reqIds } },
        orderBy: { level: 'asc' },
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
      histories.forEach((h) => {
        if (h.orgReqId) {
          if (h.event === 'INITIATE' && h.eventUserId) {
            initiatorMap.set(h.orgReqId, h.eventUserId);
          }
          if (h.event === 'APPROVED' && h.eventUserId) {
            const approvedUsers =
              approvedUserMap.get(h.orgReqId) || new Set<string>();
            approvedUsers.add(h.eventUserId);
            approvedUserMap.set(h.orgReqId, approvedUsers);
          }
        }
      });
      // console.log(`[OrgHistory] Built initiatorMap with ${initiatorMap.size} entries`);

      // Filter each stored approver list for active display only. The DB row is not mutated.
      for (const [reqId, levels] of workflowMap.entries()) {
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
              'ORG_STR',
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
        ...histories.map((h) => h.eventUserId),
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
      const historyUserMap = new Map(
        histories.map((h) => [
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
        { level: number | null; createdAt: Date | string | null }
      >();
      histories.forEach((h) => {
        if (h.orgReqId && h.event === 'APPROVED' && h.level) {
          const key = `${h.orgReqId}:${h.level}`;
          const existing = approvedEventsByReqLevel.get(key) || [];
          existing.push({
            historyId: h.id,
            user: historyUserMap.get(h.eventUserId),
            createdAt: h.createdAt,
          });
          approvedEventsByReqLevel.set(key, existing);
        }
        if (h.orgReqId && h.event === 'REJECTED') {
          const existing = rejectedEventByReqId.get(h.orgReqId);
          const currentTime = h.createdAt ? new Date(h.createdAt).getTime() : 0;
          const existingTime = existing?.createdAt
            ? new Date(existing.createdAt).getTime()
            : -1;
          if (!existing || currentTime >= existingTime) {
            rejectedEventByReqId.set(h.orgReqId, {
              level: h.level ?? null,
              createdAt: h.createdAt,
            });
          }
        }
      });
      const getMandatoryApprovalCount = (level: any) =>
        Math.max(Number(level?.mandatoryCount || 1), 1);
      const getLevelRule = (level: any) =>
        getMandatoryApprovalCount(level) > 1 ? 'AND' : null;
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
              approvedEventStepByHistoryId.set(
                event.historyId,
                nextStep + index,
              );
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
        approvalStepMetaByReqId.get(reqId)?.levelStartByLevel.get(level) ??
        null;
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
        const request = histories.find((history) => history.orgReqId === reqId);
        const requestStatus = request?.orgReq?.status || null;
        const normalizedRequestStatus = String(
          requestStatus || '',
        ).toUpperCase();

        if (levels.length === 0) {
          return {
            ...OrgStructureDbController.getEmptyOrgHistoryApprovalSummary(),
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
            : allApproved || normalizedRequestStatus === 'APPROVED'
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
      const buildEligibleApprovers = (reqId: string) => {
        const levels = workflowMap.get(reqId) || [];
        const pendingLevel = levels.find((l: any) => l.status === 'PENDING');
        if (!pendingLevel) return [];
        const approverIds = Array.isArray(pendingLevel.approversList)
          ? (pendingLevel.approversList as string[])
          : [];
        return approverIds
          .map((id: string) => {
            const user = approverMap.get(id);
            return user ? { name: user.name, email: user.email } : null;
          })
          .filter(Boolean);
      };

      const modificationSequenceByReqId = new Map<string, number>();
      const historyByReqId = new Map<string, any[]>();
      histories
        .filter((history) => history.orgReqId)
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
        .forEach((history) => {
          if (history.orgReqId) {
            const existingEntries = historyByReqId.get(history.orgReqId) || [];
            existingEntries.push(history);
            historyByReqId.set(history.orgReqId, existingEntries);
          }
          const requestType =
            OrgStructureDbController.resolveOrgHistoryRequestType(
              history.orgReq,
            );
          if (
            history.event === 'INITIATE' &&
            requestType !== 'INITIATE' &&
            history.orgReqId &&
            !modificationSequenceByReqId.has(history.orgReqId)
          ) {
            modificationSequenceByReqId.set(
              history.orgReqId,
              modificationSequenceByReqId.size + 1,
            );
          }
        });

      // 3. Add actual history entries
      const formattedHistories = histories.map((h) => {
        const data = h.orgReq?.data as any;
        const requestType =
          OrgStructureDbController.resolveOrgHistoryRequestType(h.orgReq);
        const isChangeRequestStart =
          h.event === 'INITIATE' && requestType !== 'INITIATE';
        const displayEvent = OrgStructureDbController.getOrgHistoryDisplayEvent(
          h.event,
          requestType,
        );
        const approvalSummary = h.orgReqId
          ? buildApprovalSummary(h.orgReqId)
          : OrgStructureDbController.getEmptyOrgHistoryApprovalSummary();
        const approvalLevel =
          displayEvent === 'APPROVED' || displayEvent === 'REJECTED'
            ? (h.level ?? null)
            : approvalSummary.currentStatus === 'PENDING'
              ? ((approvalSummary as any).currentPendingLevel ?? null)
              : null;
        const approvalStep =
          displayEvent === 'APPROVED' && h.orgReqId && h.level
            ? getApprovedEventStep(h.orgReqId, h.level, h.id)
            : displayEvent === 'REJECTED' && h.orgReqId && h.level
              ? getRejectedApprovalStep(h.orgReqId, h.level)
              : approvalSummary.currentStatus === 'PENDING'
                ? ((approvalSummary as any).currentPendingStep ?? null)
                : null;
        const levelCount = OrgStructureDbController.getOrgHistoryLevelCount(
          displayEvent || '',
          {
            approvalLevel,
            approvalStep,
            isChangeRequestStart,
            modificationSequence: h.orgReqId
              ? modificationSequenceByReqId.get(h.orgReqId) || 1
              : null,
          },
        );
        const approvedBy = h.orgReqId ? buildApprovedBy(h.orgReqId) : [];

        const result: Record<string, any> = {
          id: h.id,
          orgReqId: h.orgReqId,
          type: requestType,
          impact: h.orgReq?.impact || null,
          companyCode: h.company.companyCode,
          oldData:
            h.orgReq?.oldData || ((h.orgReq?.data as any)?.oldData ?? null),
          newData: h.orgReq?.data || null,
          event: displayEvent,
          levelCount,
          createdAt: h.createdAt,
          remarks: h.remarks,
          user: HistoryUserUtil.formatAuditUser(
            h.user,
            h.eventUserId,
            saasAdminUserIds,
            viewerUserId,
          ),
          nodeId: data?.nodeId || data?.orgStructureId || null,
          orgStructureId: data?.orgStructureId || data?.nodeId || null,
          newNodeName: data?.newNodeName || null,
          nodeType: data?._nodeType || data?.nodeType || null,
          nodePath: data?.nodePath || null,
          parentNodePath: data?.parentNode?.nodePath || 'ROOT',
          parentNodeName: data?.parentNode?.nodeName || 'ROOT',
          approvalLevel,
          _reqId: h.orgReqId || null,
        };

        if (displayEvent === 'APPROVED' && approvalLevel != null) {
          result.level = approvalLevel;
          result.approvalSummary = {
            currentStatus: approvalSummary.currentStatus,
            totalLevels: approvalSummary.totalLevels,
            completedLevels: approvalSummary.completedLevels,
          };
          if (approvedBy.length > 0) {
            result.approvedBy = approvedBy;
          }
        }

        if (displayEvent === 'REJECTED' && approvalLevel != null) {
          result.level = approvalLevel;
        }

        return result;
      });

      // 4. Generate synthetic approval-state events
      const syntheticEvents: any[] = [];
      const processedReqIds = new Set<string>();
      const suppressApprovedForReqIds = new Set<string>();

      for (const h of histories) {
        if (!h.orgReqId || processedReqIds.has(h.orgReqId)) continue;
        processedReqIds.add(h.orgReqId);

        const approvalSummary = buildApprovalSummary(h.orgReqId);
        const approvedBy = buildApprovedBy(h.orgReqId);

        if (approvalSummary.totalLevels === 0) continue;

        const isPending = approvalSummary.currentStatus === 'PENDING';
        const isRejected = approvalSummary.currentStatus === 'REJECTED';
        const isApproved = approvalSummary.currentStatus === 'APPROVED';
        const isMultiLevel = approvalSummary.totalLevels > 1;
        const latestEntries = historyByReqId.get(h.orgReqId) || [];
        const latestEvent = latestEntries[latestEntries.length - 1];
        const syntheticSource = latestEvent || h;
        const sourceData = syntheticSource.orgReq?.data as any;
        const requestType =
          OrgStructureDbController.resolveOrgHistoryRequestType(
            syntheticSource.orgReq,
          );

        if (isPending || isRejected) {
          suppressApprovedForReqIds.add(h.orgReqId);
        }

        if (isApproved && isMultiLevel) {
          suppressApprovedForReqIds.add(h.orgReqId);
          syntheticEvents.push({
            id: syntheticSource.id,
            orgReqId: h.orgReqId,
            type: requestType,
            impact: syntheticSource.orgReq?.impact || null,
            companyCode: syntheticSource.company.companyCode,
            oldData: null,
            newData: null,
            event: 'APPROVED',
            levelCount: `A${approvalStepMetaByReqId.get(h.orgReqId)?.totalApprovalSteps || approvalSummary.totalLevels}`,
            createdAt: latestEvent?.createdAt ?? null,
            remarks: null,
            user: HistoryUserUtil.formatAuditUser(
              syntheticSource.user,
              syntheticSource.eventUserId,
              saasAdminUserIds,
              viewerUserId,
            ),
            nodeId: sourceData?.nodeId || sourceData?.orgStructureId || null,
            orgStructureId:
              sourceData?.orgStructureId || sourceData?.nodeId || null,
            newNodeName: sourceData?.newNodeName || null,
            nodeType: sourceData?._nodeType || sourceData?.nodeType || null,
            nodePath: sourceData?.nodePath || null,
            parentNodePath: sourceData?.parentNode?.nodePath || 'ROOT',
            parentNodeName: sourceData?.parentNode?.nodeName || 'ROOT',
            approvalLevel: null,
            approvalSummary: {
              currentStatus: 'APPROVED',
              totalLevels: approvalSummary.totalLevels,
              completedLevels: approvalSummary.completedLevels,
            },
            approvedBy,
            _reqId: h.orgReqId,
          });
        }

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
            orgReqId: h.orgReqId,
            type: requestType,
            impact: syntheticSource.orgReq?.impact || null,
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
            nodeId: sourceData?.nodeId || sourceData?.orgStructureId || null,
            orgStructureId:
              sourceData?.orgStructureId || sourceData?.nodeId || null,
            newNodeName: sourceData?.newNodeName || null,
            nodeType: sourceData?._nodeType || sourceData?.nodeType || null,
            nodePath: sourceData?.nodePath || null,
            parentNodePath: sourceData?.parentNode?.nodePath || 'ROOT',
            parentNodeName: sourceData?.parentNode?.nodeName || 'ROOT',
            approvalLevel: null,
            approvalSummary: progressSummary,
            approvedBy,
            _reqId: h.orgReqId,
          });
        }

        if (isPending && (approvalSummary as any).currentPendingLevel) {
          const pendingLevel = (approvalSummary as any).currentPendingLevel;
          const pendingStep =
            (approvalSummary as any).currentPendingStep ?? pendingLevel;
          const eligibleApprovers = buildEligibleApprovers(h.orgReqId);

          syntheticEvents.push({
            id: syntheticSource.id,
            orgReqId: h.orgReqId,
            type: requestType,
            impact: syntheticSource.orgReq?.impact || null,
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
            nodeId: sourceData?.nodeId || sourceData?.orgStructureId || null,
            orgStructureId:
              sourceData?.orgStructureId || sourceData?.nodeId || null,
            newNodeName: sourceData?.newNodeName || null,
            nodeType: sourceData?._nodeType || sourceData?.nodeType || null,
            nodePath: sourceData?.nodePath || null,
            parentNodePath: sourceData?.parentNode?.nodePath || 'ROOT',
            parentNodeName: sourceData?.parentNode?.nodeName || 'ROOT',
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
            _reqId: h.orgReqId,
          });
        }
      }

      // 5. Filter duplicate individual approved entries and sort like user history
      const filteredHistory = formattedHistories.filter((item: any) => {
        if (
          item.event === 'APPROVED' &&
          item._reqId &&
          suppressApprovedForReqIds.has(item._reqId)
        ) {
          return false;
        }
        return true;
      });

      const eventPriority = (event: string) => {
        if (event && event.includes('Pending Approval')) return 0;
        if (event === 'APPROVAL_PROGRESS') return 1;
        if (event === 'REJECTED') return 2;
        if (event === 'APPROVED') return 3;
        return 4;
      };

      const resultList = [...filteredHistory, ...syntheticEvents].sort(
        (left: any, right: any) => {
          if (!left.createdAt && right.createdAt) return -1;
          if (left.createdAt && !right.createdAt) return 1;
          if (!left.createdAt && !right.createdAt) {
            return eventPriority(left.event) - eventPriority(right.event);
          }

          const leftTime = new Date(left.createdAt).getTime();
          const rightTime = new Date(right.createdAt).getTime();
          if (leftTime !== rightTime) return rightTime - leftTime;

          const leftPriority = eventPriority(left.event);
          const rightPriority = eventPriority(right.event);
          if (leftPriority !== rightPriority) {
            return leftPriority - rightPriority;
          }

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

      const cleanedResultList = dedupedResultList.map(
        ({ _reqId, ...rest }: any) => rest,
      );

      res.status(200).json({
        message: 'Organization structure history fetched successfully!',
        code: 200,
        data: cleanedResultList,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Fetches a single org history event with its resolved request snapshot.
   */
  static async getOrgHistoryDetail(
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

      const history = await prisma.orgHistory.findFirst({
        where: {
          id,
          companyId: resolvedCompanyId,
        },
        include: {
          user: {
            include: {
              userAccesses: {
                where: { companyId: resolvedCompanyId },
              },
            },
          },
          orgReq: true,
          company: { select: { companyCode: true, id: true } },
        },
      });

      if (!history) {
        throw new AppError('Organization history not found', 404);
      }
      if (
        history.event === 'AUTO_GENERATE' ||
        history.event === 'AUTO_DELETE'
      ) {
        throw new AppError('Organization history not found', 404);
      }

      const requestData = (history.orgReq?.data as any) || null;
      const requestType = String(
        history.orgReq?.type || 'INITIATE',
      ).toUpperCase();
      const displayEvent = OrgStructureDbController.getOrgHistoryDisplayEvent(
        history.event,
        requestType,
      );

      const allRequests = await prisma.orgStructureReq.findMany({
        where: { companyId: resolvedCompanyId },
        select: {
          id: true,
          data: true,
          type: true,
          status: true,
          createdAt: true,
        },
      });
      const targetNodePath =
        OrgStructureDbController.extractOrgTargetPath(requestData);
      const historyRequests = allRequests
        .filter((request) => {
          const requestTargetNodePath =
            OrgStructureDbController.extractOrgTargetPath(request.data);
          return (
            requestTargetNodePath === targetNodePath &&
            (request.status !== 'REJECTED' || request.id === history.orgReqId)
          );
        })
        .sort((left, right) => {
          const leftTime = left.createdAt.getTime();
          const rightTime = right.createdAt.getTime();
          if (leftTime !== rightTime) return leftTime - rightTime;
          return left.id.localeCompare(right.id);
        });

      let currentSnapshot: Record<string, unknown> | null = null;
      let oldData: Record<string, unknown> | null = null;
      let newData: Record<string, unknown> | null = null;

      for (const request of historyRequests) {
        const nextSnapshot: Record<string, unknown> | null =
          request.type === 'INITIATE' || !currentSnapshot
            ? OrgStructureDbController.extractOrgSnapshot(request.data)
            : OrgStructureDbController.applyOrgRequestSnapshot(
                currentSnapshot,
                request,
              );

        if (!nextSnapshot) continue;

        if (request.id === history.orgReqId) {
          oldData = currentSnapshot ? cloneJson(currentSnapshot) : null;
          newData = nextSnapshot;
          break;
        }

        currentSnapshot = nextSnapshot;
      }

      if (!newData) {
        newData = OrgStructureDbController.extractOrgSnapshot(requestData);
      }

      const saasAdminUserIds = await HistoryUserUtil.getSaasAdminUserIds([
        viewerUserId,
        history.eventUserId,
      ]);

      res.status(200).json({
        message: 'Organization structure history item fetched successfully!',
        code: 200,
        data: {
          id: history.id,
          orgReqId: history.orgReqId,
          companyCode: history.company.companyCode,
          type: history.orgReq?.type || null,
          impact: history.orgReq?.impact || null,
          event: displayEvent,
          rawEvent: history.event,
          level: history.level,
          createdAt: history.createdAt,
          remarks: history.remarks,
          oldData,
          newData,
          user: HistoryUserUtil.formatAuditUser(
            history.user,
            history.eventUserId,
            saasAdminUserIds,
            viewerUserId,
          ),
          request: history.orgReq
            ? {
                id: history.orgReq.id,
                type: history.orgReq.type,
                status: history.orgReq.status,
                workflowId: history.orgReq.workflowId,
                createdAt: history.orgReq.createdAt,
              }
            : null,
          newNodeName: requestData?.newNodeName || null,
          nodeType: requestData?._nodeType || requestData?.nodeType || null,
          nodePath: requestData?.nodePath || null,
          parentNodePath: requestData?.parentNode?.nodePath || 'ROOT',
          parentNodeName: requestData?.parentNode?.nodeName || 'ROOT',
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Fetches the complete organization structure and pending requests for a company.
   * Used to build the tree view in the UI.
   */
  static async fetchStructure(req: Request, res: Response, next: NextFunction) {
    try {
      const { companyCode, companyId, userId } = req.body;
      const requestedStatusType = String(
        req.body?.statusType ?? '',
      ).toLowerCase();
      if (
        requestedStatusType &&
        !['active', 'inactive', 'archive'].includes(requestedStatusType)
      ) {
        throw new AppError('Invalid statusType', 400);
      }
      const statusType =
        requestedStatusType === 'inactive'
          ? 'INACTIVE'
          : requestedStatusType === 'archive'
            ? 'ARCHIVE'
            : 'ACTIVE';
      let resolvedCompanyId = companyId;

      if (!resolvedCompanyId) {
        if (!companyCode) {
          return res.status(400).json({
            success: false,
            message: 'companyCode or companyId is required',
          });
        }
        const company = await prisma.company.findUnique({
          where: { companyCode: companyCode },
        });

        if (!company) {
          return res
            .status(404)
            .json({ success: false, message: 'Company not found' });
        }
        resolvedCompanyId = company.id;
      }

      // 1. Fetch all nodes in the hierarchy so child paths can be linked
      const allNodes = await prisma.orgStructure.findMany({
        where: { companyId: resolvedCompanyId },
        orderBy: { nodePath: 'asc' },
      });
      const visibleNodes = allNodes.filter(
        (node) => node.status === statusType,
      );

      // 2. Fetch pending requests for parallel tracking
      const pendingRequestsRaw = await prisma.orgStructureReq.findMany({
        where: {
          companyId: resolvedCompanyId,
          status: 'PENDING',
        },
        include: {
          orgHistories: {
            where: { event: 'INITIATE' },
            include: { user: true },
          },
        },
      });
      const effectivePendingIds =
        await OrgStructureDbController.filterEffectivelyPendingRequestIds(
          'org_structure_req',
          pendingRequestsRaw.map((request) => request.id),
        );
      const pendingRequests = pendingRequestsRaw.filter((request) =>
        effectivePendingIds.has(request.id),
      );

      // 3. Resolve workflow names and aliases for pending requests
      const workflowIds = Array.from(
        new Set(pendingRequests.map((req) => req.workflowId).filter(Boolean)),
      ) as string[];
      const workflowDetails = await prisma.workflow.findMany({
        where: { id: { in: workflowIds }, status: 'ACTIVE' },
        select: { id: true, name: true, alias: true },
      });
      const workflowMap = new Map(workflowDetails.map((w) => [w.id, w]));

      const pendingWithDetails = await Promise.all(
        pendingRequests.map(async (req) => {
          const w = req.workflowId ? workflowMap.get(req.workflowId) : null;
          const initiator = req.orgHistories[0]?.user || {
            name: '',
            email: '',
          };
          const resolvedImpactSummary =
            await OrgStructureDbController.resolveImpactSummary(
              prisma as any,
              resolvedCompanyId,
              req.type || 'INITIATE',
              req.data,
            );

          const { orgHistories, ...rest } = req;
          const reqData = req.data as any;
          const newData = {
            ...(reqData || {}),
            impactSummary: resolvedImpactSummary,
          };

          return {
            ...rest,
            oldData: req.oldData || (reqData?.oldData ?? null),
            newData,
            initiator,
            workflowName: w?.name || 'N/A',
            alias: w?.alias || 'N/A',
            impactSummary: resolvedImpactSummary,
          };
        }),
      );
      const approverRequestIds = new Set(
        await OrgStructureDbController.getCurrentApproverRequestIds(
          'org_structure_req',
          userId,
          resolvedCompanyId,
        ),
      );
      const pendingByNodePath = new Map<string, any>();
      pendingWithDetails.forEach((request: any) => {
        const requestData = request.data as any;
        const targetPath =
          requestData?.targetNodePath ||
          requestData?.nodePath ||
          requestData?.currentData?.nodePath;
        if (
          typeof targetPath === 'string' &&
          !pendingByNodePath.has(targetPath)
        ) {
          pendingByNodePath.set(targetPath, request);
        }
      });
      const visiblePendingWithDetails = pendingWithDetails.filter(
        (request: any) => approverRequestIds.has(request.id),
      );

      const pendingNodePaths = new Set<string>();
      pendingRequests.forEach((request: any) => {
        const requestData = request.data as any;
        const targetPath = OrgStructureDbController.resolveRequestedNodePath(
          requestData,
          requestData?.targetNodePath || requestData?.currentData?.nodePath,
        );
        if (typeof targetPath === 'string' && targetPath.length > 0) {
          pendingNodePaths.add(targetPath);
        }
      });

      // 4. Remove internal UUIDs and format for the tree UI
      const safeNodes = visibleNodes.map((node) => ({
        id: node.id,
        nodeId: node.id,
        nodeName: node.nodeName,
        nodeType: node.nodeType,
        nodePath: node.nodePath,
        status: node.status,
        isPending: pendingByNodePath.has(node.nodePath),
        isAutoDeleted: node.status !== 'ACTIVE',
        linkedOrgStructure: OrgStructureDbController.buildLinkedOrgStructure(
          allNodes as any,
          node.nodePath,
          pendingNodePaths,
        ),
      }));

      res.status(200).json({
        message: 'Organization structure fetched successfully!',
        code: 200,
        data: {
          nodes: safeNodes,
          pending: visiblePendingWithDetails,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}
