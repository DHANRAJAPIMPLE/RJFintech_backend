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
  workflowCount: number;
  workflowNames: string[];
};

/**
 * Controller for managing the organizational hierarchy (nodes) for companies.
 * Handles the creation, approval, and retrieval of organization units (Roots, Groups, Locations, etc.)
 */
export class OrgStructureDbController {
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
  ) {
    const corpAdminUserIds = await NotificationService.getCorpAdminUserIds(
      companyId,
    );
    const recipients = NotificationService.mergeRecipientUserIds(
      initiatorId,
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
      includeCreatedBy: true,
      isPending: false,
    });
  }

  private static pathSegment(value: string) {
    return value
      .trim()
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .toUpperCase();
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
      .slice(0, 5)
      .map(
        (workflow) =>
          `${workflow.workflowName} for ${workflow.nodeName} (${workflow.nodePath})`,
      )
      .join(', ');
    const remaining = Math.max(generatedWorkflows.length - 5, 0);
    const remainingText =
      remaining > 0 ? ` and ${remaining} more workflow(s)` : '';

    await NotificationService.createRequestNotification({
      companyId,
      type: 'ONBOARDED',
      name: 'Workflow auto-generated',
      message: `System auto-generated ${generatedWorkflows.length} workflow(s): ${generatedSummary}${remainingText}.`,
      referenceType: 'WORKFLOW',
      referenceId: params.orgReqId,
      referenceName: generatedWorkflows[0]?.nodeName || 'workflow',
      createdBy: params.createdBy,
      recipientUserIds,
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
        role: { select: { roleName: true } },
      },
    });
  }

  private static buildPropagatedAccesses(
    parentAccesses: any[],
    newNodeId: string,
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
        nodeId: newNodeId,
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
      .slice(0, 5)
      .map((change) => {
        const user = change.userName || change.userEmail || change.userId;
        const role = change.roleName || change.roleCode;
        return `${user} (${role})`;
      })
      .join(', ');
    const remaining = Math.max(accessChanges.length - 5, 0);
    const remainingText =
      remaining > 0 ? ` and ${remaining} more access change(s)` : '';

    await NotificationService.createRequestNotification({
      companyId,
      type: 'MODIFICATION',
      name: 'Organization access updated',
      message: `System added ${accessChanges.length} user role access(es) for new organization node ${params.nodeName} (${params.nodePath}). Impacted: ${impactedNames}${remainingText}.`,
      referenceId: params.orgReqId,
      referenceName: params.nodeName,
      createdBy: params.createdBy,
      recipientUserIds,
    });
  }

  private static pathsOverlap(left: string, right: string) {
    return (
      left === right ||
      left.startsWith(`${right}.`) ||
      right.startsWith(`${left}.`)
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
        workflowCount: 0,
        workflowNames: [],
      };
    }

    const workflowWhere = {
      companyId,
      nodeId: { in: subtreeIds },
      status: { not: 'ARCHIVE' },
    };

    const [accessRows, workflowCount, workflowRows] = await Promise.all([
      client.userAccess.findMany({
        where: {
          companyId,
          nodeId: { in: subtreeIds },
        },
        select: { userId: true },
      }),
      client.workflow.count({ where: workflowWhere }),
      client.workflow.findMany({
        where: workflowWhere,
        select: { name: true },
        orderBy: { createdAt: 'asc' },
        take: 5,
      }),
    ]);

    return {
      nodeName: subtreeNodes[0]?.nodeName || nodePath,
      nodePath,
      accessUserIds: Array.from(
        new Set(
          accessRows
            .map((row: any) => row.userId)
            .filter((userId: unknown): userId is string => typeof userId === 'string' && userId.trim().length > 0)
            .map((userId: string) => userId.trim()),
        ),
      ),
      workflowCount,
      workflowNames: workflowRows.map((workflow: any) => workflow.name),
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

      const requestData = {
        targetNodePath,
        ...data,
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
        notificationRecipients = workflow.eligibleApprovers;
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
      const corpAdminUserIds = await NotificationService.getCorpAdminUserIds(
        companyId,
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
          corpAdminUserIds,
        ),
        includeCreatedBy: true,
      });
      res.status(201).json(request);
    } catch (error) {
      const initiatorId = req.body?.initiatorId;
      const companyId = req.body?.companyId;
      const targetNodePath = req.body?.targetNodePath;
      if (
        typeof initiatorId === 'string' &&
        typeof companyId === 'string'
      ) {
        await OrgStructureDbController.notifyConflict(
          companyId,
          initiatorId,
          error instanceof Error ? error.message : 'Unexpected error',
          String(targetNodePath || 'organization node'),
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
    },
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

    const subtree = await OrgStructureDbController.getSubtreeNodes(
      tx,
      request.companyId,
      targetNodePath,
    );
    const subtreeIds = subtree.map((subtreeNode: any) => subtreeNode.id);
    if (notificationState) {
      notificationState.inactivation =
        await OrgStructureDbController.getOrgInactivationNotification(
          tx,
          request.companyId,
          targetNodePath,
        );
    }
    await tx.userAccess.deleteMany({
      where: { companyId: request.companyId, nodeId: { in: subtreeIds } },
    });
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
      const orgLifecycleNotification = {
        inactivation: null as OrgInactivationNotification | null,
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

          // 1. Create the actual node in the production organization structure
          const newNode = await tx.orgStructure.create({
            data: {
              companyId: request.companyId,
              nodePath: newNodePath,
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
              newNodePath,
            );
          const newAccesses = OrgStructureDbController.buildPropagatedAccesses(
            parentAccesses,
            newNode.id,
          );

          if (newAccesses.length > 0) {
            await tx.userAccess.createMany({
              data: newAccesses.map(
                ({ userName, userEmail, roleName, ...access }: any) => access,
              ),
              skipDuplicates: true,
            });
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
              remarks,
            },
          });

          return { ...updated, status: 'APPROVED' };
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

      if (notificationCompanyId) {
        const requestInitiatorId =
          await NotificationService.getRequestInitiatorId(
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
        const notificationRecipientUserIds =
          NotificationService.mergeRecipientUserIds(
            notificationRecipients,
            requestInitiatorId,
            isOrgInactivation
              ? inactivationNotification?.accessUserIds
              : [],
          );
        const orgNotificationContent = isOrgInactivation
          ? {
              name: 'Organization Removed',
              message: `Organization ${inactivationNotification?.nodeName || notificationSubject} (${inactivationNotification?.nodePath || notificationSubject}) was inactivated. ${inactivationNotification?.workflowCount || 0} workflow(s) were deleted ${inactivationNotification?.workflowNames && inactivationNotification.workflowNames.length > 0 ? `: ${inactivationNotification.workflowNames.join(', ')}` : ''}. Access was removed for ${inactivationNotification?.accessUserIds.length || 0} user(s).`,
            }
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
            corpAdminUserIds,
          ),
          includeCreatedBy: true,
          isPending: result?.status === 'PARTIAL_APPROVED',
        });
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
        await OrgStructureDbController.notifyConflict(
          resolvedCompanyId,
          initiatorId,
          error instanceof Error ? error.message : 'Unexpected error',
          String(
            req.body?.targetNodePath ||
              req.body?.data?.newNodeName ||
              'organization',
          ),
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
      if (String(req.body?.type || 'INITIATE').toUpperCase() === 'UPDATE') {
        return OrgStructureDbController.createModificationRequest(
          req,
          res,
          next,
        );
      }

      const { initiatorId, companyCode, companyId, levelsHash, ...rest } =
        req.body;
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
          OrgStructureDbController.resolveRequestedNodePath(reqData);
        const propagatedAccessCount =
          await OrgStructureDbController.countPropagatedUserAccesses(
            tx,
            resolvedCompanyId,
            requestedNodePath,
          );
        const reqRecord = await tx.orgStructureReq.create({
          data: {
            ...rest,
            impact: OrgStructureDbController.formatUserAccessImpact(
              propagatedAccessCount,
            ),
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
          const {
            workflowId: resolvedWorkflowId,
            eligibleApprovers: resolvedApprovers,
          } = await WorkflowApproverUtil.resolveAndCreateApprovers(tx, {
            levelsHash: levelsHash || null,
            module: 'SYSTEM_ACCESS',
            subModule: 'ORG_STR',
            companyId: resolvedCompanyId,
            nodeId,
            initiatorId,
            reqId: reqRecord.id,
            reqTable: 'org_structure_req',
          });
          notificationRecipients = resolvedApprovers;

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
      await NotificationService.createRequestNotification({
        companyId: resolvedCompanyId,
        type: 'INITIATE',
        referenceType: 'ORG',
        referenceId: request.id,
        referenceName: rest.data?.newNodeName,
        createdBy: initiatorId,
        recipientUserIds: NotificationService.mergeRecipientUserIds(
          notificationRecipients,
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

      // 2. Prevent overlapping pending requests for the same node name
      const pendingCheck = await prisma.orgStructureReq.findFirst({
        where: {
          companyId: resolvedCompanyId,
          status: 'PENDING',
          data: {
            path: ['newNodeName'],
            equals: newNodeName,
          },
        },
      });

      if (pendingCheck) {
        return res.status(400).json({
          success: false,
          message: `A request for node '${newNodeName}' is already pending for this location`,
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

      // Filter out rejected org structure requests
      const rejectedReqIds = new Set<string>();
      histories.forEach((h) => {
        if (
          h.orgReqId &&
          (h.event === 'REJECTED' || h.orgReq?.status === 'REJECTED')
        ) {
          rejectedReqIds.add(h.orgReqId);
        }
      });

      histories = histories.filter(
        (h) => !h.orgReqId || !rejectedReqIds.has(h.orgReqId),
      );
      if (applyHistoryFilter) {
        histories = histories.filter((h) =>
          matchesNodeFilter(h.orgReq?.data as any),
        );
      }

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

      const resultList: any[] = [];
      const handledPendingReqs = new Set<string>();

      // 3. Inject "Pending Approval" entries for any active requests
      histories.forEach((h) => {
        if (h.orgReqId && !handledPendingReqs.has(h.orgReqId)) {
          const levels = workflowMap.get(h.orgReqId);
          if (levels) {
            const currentPending = levels.find((l) => l.status === 'PENDING');
            if (currentPending) {
              const approvers = (currentPending.approversList as string[])
                .map((id) => {
                  const u = approverMap.get(id);
                  return u ? { name: u.name, email: u.email } : null;
                })
                .filter(Boolean);

              const data = h.orgReq?.data as any;
              resultList.push({
                id: h.id,
                orgReqId: h.orgReqId,
                type: h.orgReq?.type || null,
                impact: h.orgReq?.impact || null,
                companyCode: h.company.companyCode,
                oldData:
                  h.orgReq?.oldData ||
                  ((h.orgReq?.data as any)?.oldData ?? null),
                newData: h.orgReq?.data || null,
                event: `L${currentPending.level} Pending Approval`,
                createdAt: null,
                eligibleapprovers: approvers,
                nodeId: data?.nodeId || data?.orgStructureId || null,
                orgStructureId: data?.orgStructureId || data?.nodeId || null,
                newNodeName: data?.newNodeName || null,
                nodeType: data?._nodeType || data?.nodeType || null,
                nodePath: data?.nodePath || null,
                parentNodePath: data?.parentNode?.nodePath || 'ROOT',
                parentNodeName: data?.parentNode?.nodeName || 'ROOT',
              });
            }
          }
          handledPendingReqs.add(h.orgReqId);
        }
      });

      // 4. Format history for easy display
      const formattedHistories = histories.map((h) => {
        const data = h.orgReq?.data as any;
        const displayEvent =
          h.event === 'INITIATE' &&
          h.orgReq?.type &&
          h.orgReq.type !== 'INITIATE'
            ? 'MODIFY'
            : h.event;

        const levels = h.orgReqId ? workflowMap.get(h.orgReqId) : null;
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
          orgReqId: h.orgReqId,
          type: h.orgReq?.type || null,
          impact: h.orgReq?.impact || null,
          companyCode: h.company.companyCode,
          oldData:
            h.orgReq?.oldData || ((h.orgReq?.data as any)?.oldData ?? null),
          newData: h.orgReq?.data || null,
          event: displayEvent,
          level: h.level,
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
        };
      });

      resultList.push(...formattedHistories);

      res.status(200).json({
        message: 'Organization structure history fetched successfully!',
        code: 200,
        data: resultList,
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

      const requestData = (history.orgReq?.data as any) || null;
      const requestType = String(history.orgReq?.type || 'INITIATE').toUpperCase();
      const displayEvent =
        history.event === 'INITIATE' && requestType !== 'INITIATE'
          ? 'MODIFY'
          : history.event;

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
      const targetNodePath = OrgStructureDbController.extractOrgTargetPath(
        requestData,
      );
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

      // 1. Fetch active nodes in the hierarchy
      const nodes = await prisma.orgStructure.findMany({
        where: { companyId: resolvedCompanyId, status: 'ACTIVE' },
        orderBy: { nodePath: 'asc' },
      });

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

      const pendingWithDetails = pendingRequests.map((req) => {
        const w = req.workflowId ? workflowMap.get(req.workflowId) : null;
        const initiator = req.orgHistories[0]?.user || { name: '', email: '' };

        const { orgHistories, ...rest } = req;
        return {
          ...rest,
          oldData: req.oldData || ((req.data as any)?.oldData ?? null),
          newData: req.data || null,
          initiator,
          workflowName: w?.name || 'N/A',
          alias: w?.alias || 'N/A',
        };
      });
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

      // 4. Remove internal UUIDs and format for the tree UI
      const safeNodes = nodes.map((node) => ({
          id: node.id,
          nodeId: node.id,
          nodeName: node.nodeName,
          nodeType: node.nodeType,
          nodePath: node.nodePath,
          isPending: pendingByNodePath.has(node.nodePath),
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
