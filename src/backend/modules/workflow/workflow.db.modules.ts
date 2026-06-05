import type { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../../shared/middlewares/error.middleware';
import { WorkflowApproverUtil } from '../../utils/workflow-approver.util';
import { NotificationService } from '../notifications/notification.db.modules';
import { HistoryUserUtil } from '../../utils/history-user.util';
import {
  buildJsonPatch,
  cloneJson,
  mergeJsonData,
} from '../../utils/json-patch.util';
import {
  appendCursorWhere,
  buildPage,
  getInMemoryPageRows,
  getPageOrder,
  isRowInCursorDirection,
  resolveCursorPagination,
} from '../../../shared/utils/cursor-pagination.util';

type WorkflowTarget = {
  id?: string;
  name?: string;
  module: string;
  subModule: string;
  nodePath: string;
  levelsHash: string;
};

type HistoryChangeCount = {
  added: number;
  modify: number;
  remove: number;
};

type WorkflowHistoryIdentityFilter = {
  module?: string;
  subModule?: string;
  nodePath?: string;
  nodeId?: string;
  levelsHash?: string;
};

/**
 * Controller for handling workflow-related database operations.
 * Manages the lifecycle of workflow requests (initiation, approval/rejection)
 * and the retrieval of active workflows and their histories.
 */
export class WorkflowDbController {
  private static getWorkflowNotificationContent(
    type: string | null | undefined,
    phase: 'initiated' | 'approved' | 'rejected',
    referenceName: string,
  ) {
    const normalizedType = String(type || 'INITIATE').toUpperCase();
    const label =
      normalizedType === 'UPDATE'
        ? 'Workflow modification'
        : normalizedType === 'ACTIVE'
          ? 'Workflow activation'
          : normalizedType === 'INACTIVE'
            ? 'Workflow inactivation'
            : normalizedType === 'ARCHIVE'
              ? 'Workflow archive'
              : 'Workflow onboarding';

    return {
      name: `${label} ${phase}`,
      message: `${label} request ${phase} for ${referenceName}`,
    };
  }

  private static getWorkflowNotificationType(
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

  private static getWorkflowRequestDisplayName(request: any) {
    const requestData = request?.data as any;
    const targetData = requestData?.target as any;
    const name =
      typeof requestData?.name === 'string' ? requestData.name.trim() : '';
    const targetName =
      typeof targetData?.name === 'string' ? targetData.name.trim() : '';
    const alias =
      typeof request?.alias === 'string' ? request.alias.trim() : '';
    const module =
      typeof request?.module === 'string' ? request.module.trim() : '';
    const subModule =
      typeof request?.subModule === 'string' ? request.subModule.trim() : '';
    const levelsHash =
      typeof request?.levelsHash === 'string' ? request.levelsHash.trim() : '';

    return (
      name ||
      targetName ||
      alias ||
      [module, subModule, levelsHash].filter(Boolean).join(' / ') ||
      'workflow request'
    );
  }

  private static getWorkflowHistoryDisplayEvent(
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

  private static resolveWorkflowHistoryRequestType(
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

  private static isWorkflowModificationHistoryType(
    requestType: string | null | undefined,
  ) {
    return String(requestType || 'INITIATE').toUpperCase() === 'UPDATE';
  }

  private static isWorkflowStatusOnlyHistoryType(
    requestType: string | null | undefined,
  ) {
    const normalizedType = String(requestType || 'INITIATE').toUpperCase();
    return normalizedType === 'INACTIVE' || normalizedType === 'ARCHIVE';
  }

  private static isWorkflowAutoHistoryType(
    requestType: string | null | undefined,
    event?: string | null | undefined,
  ) {
    const normalizedType = String(requestType || '').toUpperCase();
    const normalizedEvent = String(event || '').toUpperCase();
    return (
      normalizedType === 'AUTO_GENERATE' ||
      normalizedType === 'AUTO_DELETE' ||
      normalizedEvent === 'AUTO_GENERATE' ||
      normalizedEvent === 'AUTO_DELETE'
    );
  }

  private static async getAutoGeneratedParentMap(
    client: any,
    companyId: string,
  ) {
    const rows = await client.workflowReq.findMany({
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
      const parentId = (request.data as any)?.sourceWorkflowId;
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

  private static async getAutoDeletedWorkflowIds(
    client: any,
    companyId: string,
  ) {
    const rows = await client.workflowReqHistory.findMany({
      where: {
        companyId,
        event: 'AUTO_DELETE',
        workflowReq: {
          workflowId: { not: null },
        },
      },
      select: {
        workflowReq: {
          select: {
            workflowId: true,
          },
        },
      },
    });

    return new Set<string>(
      rows
        .map((row: any) => row.workflowReq?.workflowId)
        .filter(
          (workflowId: unknown): workflowId is string =>
            typeof workflowId === 'string' && workflowId.length > 0,
        ),
    );
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

  private static async getWorkflowFamilyRequestIds(
    client: any,
    companyId: string,
    rootWorkflowId: string,
    nodeAccessFilter: Record<string, any> = {},
  ) {
    const parentByWorkflowId =
      await WorkflowDbController.getAutoGeneratedParentMap(client, companyId);
    const descendantWorkflowIds =
      WorkflowDbController.collectWorkflowDescendantIds(
        parentByWorkflowId,
        rootWorkflowId,
      );
    const workflowIds = [rootWorkflowId, ...descendantWorkflowIds];

    const [familyWorkflows, linkedRequests] = await Promise.all([
      client.workflow.findMany({
        where: {
          companyId,
          id: { in: workflowIds },
          ...nodeAccessFilter,
        },
        select: { workflowReqIds: true },
      }),
      client.workflowReq.findMany({
        where: {
          companyId,
          workflowId: { in: workflowIds },
          ...nodeAccessFilter,
        },
        select: { id: true },
      }),
    ]);

    return new Set<string>([
      ...familyWorkflows.flatMap((workflow: any) =>
        Array.isArray(workflow.workflowReqIds) ? workflow.workflowReqIds : [],
      ),
      ...linkedRequests.map((request: any) => request.id),
    ]);
  }

  private static async getExactWorkflowRequestIds(
    client: any,
    companyId: string,
    workflowId: string,
    nodeAccessFilter: Record<string, any> = {},
  ) {
    const [workflow, linkedRequests] = await Promise.all([
      client.workflow.findFirst({
        where: {
          id: workflowId,
          companyId,
          ...nodeAccessFilter,
        },
        select: { workflowReqIds: true },
      }),
      client.workflowReq.findMany({
        where: {
          companyId,
          workflowId,
          ...nodeAccessFilter,
        },
        select: { id: true, type: true, data: true },
      }),
    ]);

    const storedRequestIds = new Set(
      Array.isArray(workflow?.workflowReqIds) ? workflow.workflowReqIds : [],
    );
    const exactLinkedRequestIds = linkedRequests
      .filter((request: any) => {
        if (storedRequestIds.has(request.id)) return true;
        if (request.type !== 'AUTO_GENERATE') return true;
        return (request.data as any)?.sourceWorkflowId !== workflowId;
      })
      .map((request: any) => request.id);

    return new Set<string>([
      ...Array.from(storedRequestIds),
      ...exactLinkedRequestIds,
    ]);
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

  private static async getCurrentViewerRequestIds(
    userId: string | null | undefined,
    companyId: string,
  ) {
    if (!userId) return [];

    const [approverRows, initiatedRows] = await Promise.all([
      prisma.workflowApprover.findMany({
        where: { reqTable: 'workflow_req', status: 'PENDING' },
        select: { reqId: true, approversList: true },
      }),
      prisma.workflowReq.findMany({
        where: {
          companyId,
          status: 'PENDING',
          initiatorId: userId,
        },
        select: { id: true },
      }),
    ]);

    const approverRequestIds = approverRows
      .filter(
        (row) =>
          Array.isArray(row.approversList) &&
          row.approversList.includes(userId),
      )
      .map((row) => row.reqId);
    const initiatorRequestIds = initiatedRows.map((row) => row.id);

    return Array.from(new Set([...approverRequestIds, ...initiatorRequestIds]));
  }

  private static async notifyConflict(
    companyId: string,
    initiatorId: string,
    message: string,
    referenceName: string,
    referenceId?: string | null,
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
      name: 'Workflow request failed',
      message: `Workflow request failed: ${message}`,
      referenceType: 'WORKFLOW',
      referenceId: referenceId || null,
      referenceName,
      createdBy: initiatorId,
      recipientUserIds: recipients,
      requiredRecipientUserIds: NotificationService.mergeRecipientUserIds(
        initiatorId,
        approverUserIds,
      ),
      includeCreatedBy: true,
      isPending: false,
    }).catch(() => undefined);
  }

  private static pathsOverlap(left: string, right: string) {
    return (
      left === right ||
      left.startsWith(`${right}.`) ||
      right.startsWith(`${left}.`)
    );
  }

  private static buildWorkflowTree(
    roots: any[],
    allRows: any[],
    parentByWorkflowId: Map<string, string>,
    pendingWorkflowIds: Set<string>,
    autoDeletedWorkflowIds: Set<string> = new Set<string>(),
  ) {
    const rowsById = new Map(allRows.map((row) => [row.id, row]));
    const childrenByParentId = new Map<string, string[]>();

    allRows.forEach((row) => {
      const parentId = parentByWorkflowId.get(row.id);
      if (!parentId || !rowsById.has(parentId)) return;
      const children = childrenByParentId.get(parentId) || [];
      children.push(row.id);
      childrenByParentId.set(parentId, children);
    });

    const sortIds = (ids: string[]) =>
      [...ids].sort((leftId, rightId) => {
        const left = rowsById.get(leftId);
        const right = rowsById.get(rightId);
        const leftTime =
          left?.createdAt instanceof Date
            ? left.createdAt.getTime()
            : new Date(left?.createdAt || 0).getTime();
        const rightTime =
          right?.createdAt instanceof Date
            ? right.createdAt.getTime()
            : new Date(right?.createdAt || 0).getTime();
        if (leftTime !== rightTime) return leftTime - rightTime;
        return leftId.localeCompare(rightId);
      });

    const collectDescendants = (row: any, visited: Set<string>): any[] => {
      const childIds = sortIds(childrenByParentId.get(row.id) || []);
      const descendants: any[] = [];

      for (const childId of childIds) {
        const childRow = rowsById.get(childId);
        if (!childRow || visited.has(childRow.id)) continue;
        visited.add(childRow.id);
        descendants.push({
          ...childRow,
          isPending: pendingWorkflowIds.has(childRow.id),
          isAutoDeleted: autoDeletedWorkflowIds.has(childRow.id),
          pendingRequest: childRow.pendingRequest ?? null,
        });
        descendants.push(...collectDescendants(childRow, visited));
      }

      return descendants;
    };

    const buildNode = (row: any): any => {
      const { pendingRequest: _pendingRequest, ...restRow } = row;
      const linkedOrgStructure = collectDescendants(
        row,
        new Set<string>([row.id]),
      ).map((child: any) => ({
        nodePath: child.orgStructure?.nodePath || null,
        nodeName: child.orgStructure?.nodeName || null,
        nodeType: child.orgStructure?.nodeType || null,
      }));

      return {
        ...restRow,
        associateAlias: {
          workflowName: row.name ?? null,
          workflowAlias: row.alias ?? null,
        },
        isPending: pendingWorkflowIds.has(row.id),
        isAutoDeleted: autoDeletedWorkflowIds.has(row.id),
        linkedOrgStructure,
      };
    };

    return roots.map((root) => buildNode(rowsById.get(root.id) || root));
  }

  private static buildLinkedOrgStructure(
    orgNodes: Array<{
      nodePath: string;
      nodeName: string;
      nodeType: string;
    }>,
    rootNodePath?: string | null,
  ) {
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
      }));
  }

  private static formatConflictDate(value: Date | string | null | undefined) {
    if (!value) return 'N/A';
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? 'N/A' : date.toISOString();
  }

  private static buildLevelsHash(levels: any): string {
    const normalized = Object.keys(levels || {})
      .filter((key) => Boolean(levels[key]))
      .sort()
      .map((key) => ({
        approvers: [levels[key].approver1, levels[key].approver2 ?? null]
          .filter(Boolean)
          .sort(),
        type: levels[key].type ?? 'OR',
      }));

    if (normalized.length === 0) {
      throw new AppError(
        'At least one workflow approval level is required',
        400,
      );
    }

    return createHash('md5').update(JSON.stringify(normalized)).digest('hex');
  }

  private static buildAlias(levels: any): string {
    let totalApprovers = 0;
    let totalLevels = 0;

    for (const level of Object.values(levels || {})) {
      if (!level) continue;
      totalLevels++;
      const current = level as any;
      totalApprovers += current.approver2 && current.type === 'AND' ? 2 : 1;
    }

    return `1M_${totalApprovers}C_${totalLevels}`;
  }

  private static toLevelsPayload(levels: any[]) {
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

  private static normalizeWorkflowType(value: unknown) {
    if (typeof value !== 'string') return 'NODE';
    const normalized = value
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, '_');
    if (normalized === 'ALL_CHILD') return 'ALL_CHILD';
    if (
      normalized === 'IMMEDIATE_CHILD' ||
      normalized === 'IMMEDIATE_APPROVER' ||
      normalized === 'IMMEDATE_APPROVER'
    ) {
      return 'IMMEDIATE_CHILD';
    }
    return 'NODE';
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

  private static normalizeWorkflowLevel(level: any) {
    if (!level || typeof level !== 'object') {
      return {
        approver1: null,
        approver2: null,
        type: 'OR',
      };
    }

    return {
      approver1: level.approver1 ?? null,
      approver2: level.approver2 ?? null,
      type: level.type ?? 'OR',
    };
  }

  private static getWorkflowLevelMap(levels: unknown) {
    if (!levels || typeof levels !== 'object' || Array.isArray(levels)) {
      return new Map<
        number,
        { approver1: unknown; approver2: unknown; type: unknown }
      >();
    }

    const entries = Object.entries(levels as Record<string, any>)
      .map(([key, level]) => {
        const levelNumber = Number.parseInt(key.replace(/^l/i, ''), 10);
        return [
          levelNumber,
          WorkflowDbController.normalizeWorkflowLevel(level),
        ] as const;
      })
      .filter(([levelNumber]) => Number.isFinite(levelNumber));

    return new Map(entries);
  }

  private static normalizeWorkflowSnapshotSource(data: any) {
    return data?.target ?? data?.newData ?? data?.data ?? data ?? {};
  }

  private static normalizeWorkflowSnapshotDataSource(data: any) {
    return data?.newData ?? data?.data ?? data ?? {};
  }

  private static normalizeWorkflowLevelsPayload(levelsSource: any) {
    if (Array.isArray(levelsSource)) {
      return levelsSource.reduce((payload: Record<string, any>, level: any) => {
        payload[`l${level.level}`] = {
          approver1: level.approver1,
          approver2: level.approver2 || null,
          type: level.approverType || level.type || 'OR',
        };
        return payload;
      }, {});
    }

    if (levelsSource && typeof levelsSource === 'object') {
      return Object.entries(levelsSource).reduce(
        (payload: Record<string, any>, [key, level]) => {
          if (!level || typeof level !== 'object') {
            payload[key] = level;
            return payload;
          }

          const configured = level as any;
          payload[key] = {
            approver1: configured.approver1 ?? null,
            approver2: configured.approver2 ?? null,
            type: configured.type ?? configured.approverType ?? 'OR',
          };
          return payload;
        },
        {},
      );
    }

    return {};
  }

  private static extractWorkflowTarget(data: any) {
    const source = WorkflowDbController.normalizeWorkflowSnapshotSource(data);
    const target = source?.target || {};
    const nodePath =
      target?.nodePath ||
      source?.nodePath ||
      source?.orgStructure?.nodePath ||
      null;
    const module = target?.module || source?.module || null;
    const subModule = target?.subModule || source?.subModule || null;
    const levelsHash = target?.levelsHash || source?.levelsHash || null;

    if (!module || !subModule || !nodePath || !levelsHash) {
      return null;
    }

    return {
      module,
      subModule,
      nodePath,
      levelsHash,
    };
  }

  private static workflowRequestMatchesHistoryIdentity(
    request: any,
    filter: WorkflowHistoryIdentityFilter,
    currentWorkflow?: any,
  ) {
    const data = (request?.data as any) || {};
    const target = WorkflowDbController.extractWorkflowTarget(data);
    const targetData = data?.target || {};

    const requestModule =
      target?.module ||
      data?.module ||
      request?.module ||
      currentWorkflow?.module;
    const requestSubModule =
      target?.subModule ||
      data?.subModule ||
      request?.subModule ||
      currentWorkflow?.subModule;
    const requestLevelsHash =
      target?.levelsHash ||
      data?.levelsHash ||
      request?.levelsHash ||
      currentWorkflow?.levelsHash;
    const requestNodePath =
      target?.nodePath ||
      targetData?.nodePath ||
      data?.nodePath ||
      data?.orgStructure?.nodePath ||
      currentWorkflow?.orgStructure?.nodePath ||
      null;
    const requestNodeId = request?.nodeId || currentWorkflow?.nodeId;

    if (filter.module && requestModule !== filter.module) return false;
    if (filter.subModule && requestSubModule !== filter.subModule) {
      return false;
    }
    if (filter.levelsHash && requestLevelsHash !== filter.levelsHash) {
      return false;
    }
    if (filter.nodePath) {
      const matchesNodePath = requestNodePath === filter.nodePath;
      const matchesNodeId =
        Boolean(filter.nodeId) && requestNodeId === filter.nodeId;
      if (!matchesNodePath && !matchesNodeId) return false;
    }

    return true;
  }

  private static normalizeHistoryLookupId(value: unknown) {
    if (typeof value !== 'string') return value;
    const pendingMatch = value.match(
      /^pending-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-\d+)?$/i,
    );
    return pendingMatch?.[1] || value;
  }

  private static extractWorkflowSnapshot(data: any, fallback: any = {}) {
    const source =
      WorkflowDbController.normalizeWorkflowSnapshotDataSource(data);
    const target = source?.target || {};
    const levels = WorkflowDbController.normalizeWorkflowLevelsPayload(
      source?.levels ?? fallback?.levels,
    );

    const module = source?.module || fallback?.module || target?.module || null;
    const subModule =
      source?.subModule || fallback?.subModule || target?.subModule || null;
    const nodePath =
      source?.nodePath ||
      fallback?.nodePath ||
      source?.orgStructure?.nodePath ||
      fallback?.orgStructure?.nodePath ||
      target?.nodePath ||
      null;
    const levelsHash =
      source?.levelsHash || fallback?.levelsHash || target?.levelsHash || null;

    if (!module || !subModule || !nodePath || !levelsHash) {
      return null;
    }

    return {
      name: source?.name || fallback?.name || '',
      alias: source?.alias || fallback?.alias || '',
      workflowType: source?.workflowType || fallback?.workflowType || 'NODE',
      module,
      subModule,
      nodePath,
      levels,
      levelsHash,
      status: source?.status || fallback?.status || 'ACTIVE',
    };
  }

  private static applyWorkflowRequestSnapshot(current: any, request: any) {
    const source = WorkflowDbController.normalizeWorkflowSnapshotDataSource(
      request?.data,
    );
    const fallback = {
      alias: request?.alias,
      module: request?.module,
      subModule: request?.subModule,
      levelsHash: request?.levelsHash,
    };
    if (request.type === 'INITIATE' || !current) {
      return WorkflowDbController.extractWorkflowSnapshot(source, fallback);
    }

    const next = cloneJson(current);
    const {
      target: _target,
      type: _type,
      remarks: _remarks,
      ...snapshotPatch
    } = source || {};
    const merged = mergeJsonData(next, snapshotPatch);
    if (
      typeof source?.nodePath === 'string' &&
      source.nodePath.trim().length > 0
    ) {
      merged.nodePath = source.nodePath;
    } else if (
      typeof source?.target?.nodePath === 'string' &&
      source.target.nodePath.trim().length > 0
    ) {
      merged.nodePath = source.target.nodePath;
    }
    if (
      (typeof source?.target?.module === 'string' &&
        source.target.module.trim().length > 0) ||
      (typeof source?.module === 'string' && source.module.trim().length > 0) ||
      request?.module
    ) {
      merged.module =
        (typeof source?.module === 'string' && source.module.trim()) ||
        request?.module ||
        (typeof source?.target?.module === 'string' &&
          source.target.module.trim()) ||
        merged.module;
    }
    if (
      (typeof source?.target?.subModule === 'string' &&
        source.target.subModule.trim().length > 0) ||
      (typeof source?.subModule === 'string' &&
        source.subModule.trim().length > 0) ||
      request?.subModule
    ) {
      merged.subModule =
        (typeof source?.subModule === 'string' && source.subModule.trim()) ||
        request?.subModule ||
        (typeof source?.target?.subModule === 'string' &&
          source.target.subModule.trim()) ||
        merged.subModule;
    }
    if (
      source?.target?.levelsHash ||
      source?.levelsHash ||
      request?.levelsHash
    ) {
      merged.levelsHash =
        request?.levelsHash ||
        source?.levelsHash ||
        source?.target?.levelsHash ||
        merged.levelsHash;
    }
    if (source?.alias || request?.alias) {
      merged.alias = source?.alias || request?.alias || merged.alias;
    }
    if (typeof source?.name === 'string' && source.name.trim().length > 0) {
      merged.name = source.name.trim();
    }
    if (
      typeof source?.workflowType === 'string' &&
      source.workflowType.trim()
    ) {
      merged.workflowType = WorkflowDbController.normalizeWorkflowType(
        source.workflowType,
      );
    }
    if (source?.levels) {
      merged.levels = WorkflowDbController.normalizeWorkflowLevelsPayload(
        source.levels,
      );
    }
    return merged;
  }

  private static buildWorkflowOldSnapshotFromPatch(
    requestData: any,
    oldPatch: any,
    fallback: any = {},
  ) {
    if (!oldPatch || typeof oldPatch !== 'object' || Array.isArray(oldPatch)) {
      return null;
    }

    const nextSnapshot = WorkflowDbController.extractWorkflowSnapshot(
      requestData,
      fallback,
    );
    if (!nextSnapshot) return null;

    const patchedSnapshot = mergeJsonData(cloneJson(nextSnapshot), oldPatch);

    return WorkflowDbController.extractWorkflowSnapshot(
      WorkflowDbController.repairWorkflowSnapshotWithFallback(
        patchedSnapshot,
        fallback,
        oldPatch,
      ),
      fallback,
    );
  }

  private static repairWorkflowSnapshotWithFallback(
    snapshot: any,
    fallback: any = {},
    explicitPatch: any = {},
  ) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return snapshot;
    }

    const repaired = cloneJson(snapshot);
    const hasEmptyLevels =
      !repaired.levels ||
      (typeof repaired.levels === 'object' &&
        !Array.isArray(repaired.levels) &&
        Object.keys(repaired.levels).length === 0);
    if (fallback?.levels && hasEmptyLevels) {
      repaired.levels = cloneJson(fallback.levels);
    }
    if (fallback?.workflowType && !explicitPatch?.workflowType) {
      repaired.workflowType = fallback.workflowType;
    }
    if (fallback?.alias && !repaired.alias) {
      repaired.alias = fallback.alias;
    }
    if (fallback?.name && !repaired.name) {
      repaired.name = fallback.name;
    }

    return repaired;
  }

  private static pruneWorkflowHistoryDiff(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return value;
    }

    const pruned = Object.entries(value as Record<string, unknown>).reduce(
      (result, [key, entry]) => {
        const normalizedEntry =
          WorkflowDbController.pruneWorkflowHistoryDiff(entry);
        if (
          normalizedEntry &&
          typeof normalizedEntry === 'object' &&
          !Array.isArray(normalizedEntry) &&
          Object.keys(normalizedEntry as Record<string, unknown>).length === 0
        ) {
          return result;
        }

        result[key] = normalizedEntry;
        return result;
      },
      {} as Record<string, unknown>,
    );

    return pruned;
  }

  private static buildWorkflowLevelsDetailDiff(
    oldLevels: unknown,
    newLevels: unknown,
  ) {
    const oldLevelMap = WorkflowDbController.getWorkflowLevelMap(oldLevels);
    const newLevelMap = WorkflowDbController.getWorkflowLevelMap(newLevels);
    const oldDiff: Record<string, unknown> = {};
    const newDiff: Record<string, unknown> = {};
    const allLevelNumbers = new Set([
      ...Array.from(oldLevelMap.keys()),
      ...Array.from(newLevelMap.keys()),
    ]);

    for (const levelNumber of Array.from(allLevelNumbers).sort(
      (a, b) => a - b,
    )) {
      const levelKey = `l${levelNumber}`;
      const oldLevel = oldLevelMap.get(levelNumber);
      const newLevel = newLevelMap.get(levelNumber);

      if (oldLevel && !newLevel) {
        oldDiff[levelKey] = cloneJson(oldLevel);
        newDiff[levelKey] = null;
        continue;
      }

      if (!oldLevel && newLevel) {
        newDiff[levelKey] = cloneJson(newLevel);
        continue;
      }

      if (
        oldLevel &&
        newLevel &&
        JSON.stringify(oldLevel) !== JSON.stringify(newLevel)
      ) {
        oldDiff[levelKey] = cloneJson(oldLevel);
        newDiff[levelKey] = cloneJson(newLevel);
      }
    }

    return {
      oldData: Object.keys(oldDiff).length > 0 ? oldDiff : null,
      newData: Object.keys(newDiff).length > 0 ? newDiff : null,
    };
  }

  private static buildWorkflowHistoryDetailDiff(
    oldData: Record<string, unknown> | null,
    newData: Record<string, unknown> | null,
    requestType: string | null | undefined,
  ) {
    const normalizedType = String(requestType || 'INITIATE').toUpperCase();
    if (normalizedType === 'INITIATE') {
      return {
        oldData,
        newData,
      };
    }

    if (!oldData || !newData) {
      return {
        oldData,
        newData,
      };
    }

    const patch = buildJsonPatch(oldData, newData);
    if (!patch) {
      return {
        oldData: cloneJson(oldData),
        newData: null,
      };
    }

    const newPatch = WorkflowDbController.pruneWorkflowHistoryDiff(
      patch.newData,
    ) as Record<string, unknown> | null;
    const levelsDiff = WorkflowDbController.buildWorkflowLevelsDetailDiff(
      oldData.levels,
      newData.levels,
    );

    if (levelsDiff.newData) {
      if (newPatch) {
        newPatch.levels = levelsDiff.newData;
      }
    } else if (newPatch && 'levels' in newPatch) {
      delete newPatch.levels;
    }

    return {
      oldData: cloneJson(oldData),
      newData: newPatch && Object.keys(newPatch).length > 0 ? newPatch : null,
    };
  }

  private static buildWorkflowRequestSnapshotFallback(
    request: any,
    relatedWorkflow?: any,
  ) {
    const requestData = (request?.data as any) || {};
    return {
      alias: relatedWorkflow?.alias || request?.alias || null,
      name: relatedWorkflow?.name || requestData?.target?.name || null,
      module: relatedWorkflow?.module || request?.module || null,
      subModule: relatedWorkflow?.subModule || request?.subModule || null,
      levelsHash: relatedWorkflow?.levelsHash || request?.levelsHash || null,
      nodePath:
        relatedWorkflow?.orgStructure?.nodePath ||
        requestData?.nodePath ||
        requestData?.target?.nodePath ||
        null,
      levels: relatedWorkflow
        ? WorkflowDbController.toLevelsPayload(relatedWorkflow.levels)
        : requestData?.levels,
      workflowType: relatedWorkflow?.type || undefined,
      status: requestData?.status || relatedWorkflow?.status || undefined,
    };
  }

  private static buildWorkflowSnapshotFromWorkflowRecord(workflow: any) {
    if (!workflow) return null;

    const nodePath = workflow.orgStructure?.nodePath || null;
    if (
      !workflow.module ||
      !workflow.subModule ||
      !nodePath ||
      !workflow.levelsHash
    ) {
      return null;
    }

    return {
      name: workflow.name || '',
      alias: workflow.alias || '',
      workflowType: workflow.type || 'NODE',
      module: workflow.module,
      subModule: workflow.subModule,
      nodePath,
      levels: WorkflowDbController.toLevelsPayload(workflow.levels || []),
      levelsHash: workflow.levelsHash,
      status: workflow.status || 'ACTIVE',
    };
  }

  private static buildPendingWorkflowHistorySnapshots(
    request: any,
    workflow: any,
  ) {
    const oldData =
      WorkflowDbController.buildWorkflowSnapshotFromWorkflowRecord(workflow);
    if (!oldData) return null;

    const newData =
      request?.type === 'INITIATE'
        ? cloneJson(oldData)
        : WorkflowDbController.applyWorkflowRequestSnapshot(oldData, request);
    if (!newData) return null;

    return {
      oldData,
      newData,
    };
  }

  private static getWorkflowHistoryChainKey(
    request: any,
    currentWorkflow?: any,
  ) {
    const requestData = request?.data as any;
    const target = WorkflowDbController.extractWorkflowTarget(requestData);
    if (target) {
      return [
        target.module,
        target.subModule,
        target.nodePath,
        target.levelsHash,
      ].join('::');
    }

    const snapshot = WorkflowDbController.extractWorkflowSnapshot(
      requestData,
      WorkflowDbController.buildWorkflowRequestSnapshotFallback(
        request,
        currentWorkflow,
      ),
    );
    if (!snapshot) return null;

    return [
      snapshot.module,
      snapshot.subModule,
      snapshot.nodePath,
      snapshot.levelsHash,
    ].join('::');
  }

  private static buildWorkflowHistorySnapshotReplayMap(
    requests: any[],
    currentWorkflowMap: Map<string, any>,
  ) {
    const requestMap = new Map<string, any>();
    requests.forEach((request) => {
      if (request?.id) {
        requestMap.set(request.id, request);
      }
    });

    const requestsByChainKey = new Map<string, any[]>();
    requests.forEach((request) => {
      const currentWorkflow =
        request?.workflowId && currentWorkflowMap.has(request.workflowId)
          ? currentWorkflowMap.get(request.workflowId)
          : null;
      const chainKey = WorkflowDbController.getWorkflowHistoryChainKey(
        request,
        currentWorkflow,
      );
      if (!chainKey) return;
      const existing = requestsByChainKey.get(chainKey) || [];
      existing.push(request);
      requestsByChainKey.set(chainKey, existing);
    });

    const replayMap = new Map<
      string,
      {
        oldData: Record<string, unknown> | null;
        newData: Record<string, unknown> | null;
      }
    >();

    requests.forEach((request) => {
      const currentWorkflow =
        request?.workflowId && currentWorkflowMap.has(request.workflowId)
          ? currentWorkflowMap.get(request.workflowId)
          : null;
      const workflowReqIds = Array.isArray(currentWorkflow?.workflowReqIds)
        ? currentWorkflow.workflowReqIds
        : [];
      const chainRequests: any[] =
        workflowReqIds.length > 0
          ? (workflowReqIds
              .map((workflowReqId: string) => requestMap.get(workflowReqId))
              .filter(Boolean) as any[])
          : requestsByChainKey.get(
              WorkflowDbController.getWorkflowHistoryChainKey(
                request,
                currentWorkflow,
              ) || '',
            ) || [];

      const orderedRequests: any[] = Array.from(
        new Map(chainRequests.map((entry: any) => [entry.id, entry])).values(),
      ).sort((left: any, right: any) => {
        const leftTime = new Date(left.createdAt).getTime();
        const rightTime = new Date(right.createdAt).getTime();
        if (leftTime !== rightTime) return leftTime - rightTime;
        return String(left.id).localeCompare(String(right.id));
      });

      let currentSnapshot: Record<string, unknown> | null = null;
      let oldData: Record<string, unknown> | null = null;
      let newData: Record<string, unknown> | null = null;

      for (const chainRequest of orderedRequests) {
        const fallback =
          WorkflowDbController.buildWorkflowRequestSnapshotFallback(
            chainRequest,
          );
        const nextSnapshot: Record<string, unknown> | null =
          chainRequest.type === 'INITIATE'
            ? WorkflowDbController.extractWorkflowSnapshot(
                chainRequest.data,
                fallback,
              )
            : currentSnapshot
              ? WorkflowDbController.applyWorkflowRequestSnapshot(
                  currentSnapshot,
                  chainRequest,
                )
              : WorkflowDbController.extractWorkflowSnapshot(
                  chainRequest.data,
                  fallback,
                );

        if (!nextSnapshot) continue;

        if (chainRequest.id === request.id) {
          oldData = currentSnapshot
            ? cloneJson(currentSnapshot)
            : WorkflowDbController.buildWorkflowOldSnapshotFromPatch(
                chainRequest.data,
                chainRequest.oldData,
                fallback,
              );
          if (oldData && chainRequest.type !== 'INITIATE') {
            oldData = WorkflowDbController.repairWorkflowSnapshotWithFallback(
              oldData,
              fallback,
              chainRequest.oldData,
            );
          }
          newData = nextSnapshot;
          break;
        }

        currentSnapshot = nextSnapshot;
      }

      if (!newData) {
        const fallback =
          WorkflowDbController.buildWorkflowRequestSnapshotFallback(
            request,
            currentWorkflow,
          );
        newData = WorkflowDbController.extractWorkflowSnapshot(
          request.data,
          fallback,
        );
        if (!oldData && request.type !== 'INITIATE') {
          oldData = WorkflowDbController.buildWorkflowOldSnapshotFromPatch(
            request.data,
            request.oldData,
            fallback,
          );
          if (oldData) {
            oldData = WorkflowDbController.repairWorkflowSnapshotWithFallback(
              oldData,
              fallback,
              request.oldData,
            );
          }
        }
      }

      replayMap.set(request.id, {
        oldData,
        newData,
      });
    });

    return replayMap;
  }

  private static resolveWorkflowHistoryRequestSnapshots(
    request: any,
    workflow?: any,
  ) {
    if (!request) {
      return {
        oldData: null,
        newData: null,
      };
    }

    const requestType = String(request.type || 'INITIATE').toUpperCase();
    const fallback = WorkflowDbController.buildWorkflowRequestSnapshotFallback(
      request,
      workflow,
    );

    if (requestType === 'INITIATE') {
      return {
        oldData: null,
        newData: WorkflowDbController.extractWorkflowSnapshot(
          request.data,
          fallback,
        ),
      };
    }

    if (request.status === 'PENDING' && workflow) {
      return (
        WorkflowDbController.buildPendingWorkflowHistorySnapshots(
          request,
          workflow,
        ) || {
          oldData: null,
          newData: null,
        }
      );
    }

    let oldData = WorkflowDbController.buildWorkflowOldSnapshotFromPatch(
      request.data,
      request.oldData,
      fallback,
    );
    if (oldData) {
      oldData = WorkflowDbController.repairWorkflowSnapshotWithFallback(
        oldData,
        fallback,
        request.oldData,
      );
    }

    let newData =
      oldData &&
      WorkflowDbController.applyWorkflowRequestSnapshot(oldData, request);
    if (!newData) {
      newData = WorkflowDbController.extractWorkflowSnapshot(
        request.data,
        fallback,
      );
    }

    return {
      oldData,
      newData,
    };
  }

  private static getWorkflowHistoryChangeCountFromSnapshots(
    oldData: any,
    newData: any,
    requestType: string | null | undefined,
  ): HistoryChangeCount {
    const normalizedType = String(requestType || '').toUpperCase();
    if (WorkflowDbController.isWorkflowStatusOnlyHistoryType(normalizedType)) {
      return {
        added: 0,
        modify: 0,
        remove: 0,
      };
    }

    const newLevels = WorkflowDbController.getWorkflowLevelMap(newData?.levels);
    const oldLevels = WorkflowDbController.getWorkflowLevelMap(oldData?.levels);

    if (normalizedType === 'INITIATE') {
      return {
        added: newLevels.size,
        modify: 0,
        remove: 0,
      };
    }

    const counts: HistoryChangeCount = {
      added: 0,
      modify: 0,
      remove: 0,
    };
    const allLevelNumbers = new Set([
      ...Array.from(oldLevels.keys()),
      ...Array.from(newLevels.keys()),
    ]);

    for (const levelNumber of allLevelNumbers) {
      const oldLevel = oldLevels.get(levelNumber);
      const newLevel = newLevels.get(levelNumber);

      if (oldLevel && !newLevel) {
        counts.remove += 1;
        continue;
      }

      if (!oldLevel && newLevel) {
        counts.added += 1;
        continue;
      }

      if (
        oldLevel &&
        newLevel &&
        JSON.stringify(oldLevel) !== JSON.stringify(newLevel)
      ) {
        counts.modify += 1;
      }
    }

    return counts;
  }

  private static isWorkflowHistorySnapshot(value: any) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }

    return Boolean(
      value.levels &&
      typeof value.levels === 'object' &&
      !Array.isArray(value.levels) &&
      value.module &&
      value.subModule &&
      value.nodePath &&
      value.levelsHash,
    );
  }

  private static getWorkflowHistoryChangeCountFromLevelPatch(
    requestData: any,
    oldData: any,
    requestType: string | null | undefined,
  ): HistoryChangeCount | null {
    const normalizedType = String(requestType || '').toUpperCase();
    if (
      normalizedType === 'INITIATE' ||
      WorkflowDbController.isWorkflowStatusOnlyHistoryType(normalizedType)
    ) {
      return null;
    }

    if (
      !oldData?.levels ||
      typeof oldData.levels !== 'object' ||
      Array.isArray(oldData.levels) ||
      !requestData?.levels ||
      typeof requestData.levels !== 'object' ||
      Array.isArray(requestData.levels)
    ) {
      return null;
    }

    const oldLevels = WorkflowDbController.getWorkflowLevelMap(oldData.levels);
    const newLevels = WorkflowDbController.getWorkflowLevelMap(
      requestData.levels,
    );
    if (oldLevels.size === 0) {
      return null;
    }

    const counts: HistoryChangeCount = {
      added: 0,
      modify: 0,
      remove: 0,
    };

    for (const [levelNumber, oldLevel] of oldLevels.entries()) {
      const newLevel = newLevels.get(levelNumber);
      if (!newLevel) {
        counts.remove += 1;
        continue;
      }

      if (JSON.stringify(oldLevel) !== JSON.stringify(newLevel)) {
        counts.modify += 1;
      }
    }

    return counts.added || counts.modify || counts.remove ? counts : null;
  }

  private static getWorkflowHistoryChangeCount(
    requestData: any,
    oldData: any,
    requestType: string | null | undefined,
  ): HistoryChangeCount {
    if (WorkflowDbController.isWorkflowStatusOnlyHistoryType(requestType)) {
      return {
        added: 0,
        modify: 0,
        remove: 0,
      };
    }

    if (
      WorkflowDbController.isWorkflowHistorySnapshot(oldData) &&
      WorkflowDbController.isWorkflowHistorySnapshot(requestData)
    ) {
      return WorkflowDbController.getWorkflowHistoryChangeCountFromSnapshots(
        oldData,
        requestData,
        requestType,
      );
    }

    const patchCount =
      WorkflowDbController.getWorkflowHistoryChangeCountFromLevelPatch(
        requestData,
        oldData,
        requestType,
      );
    if (patchCount) {
      return patchCount;
    }

    const stored = WorkflowDbController.normalizeChangeCount(
      requestData?.changeCount ?? oldData?.changeCount,
    );
    if (stored.added || stored.modify || stored.remove) {
      return stored;
    }

    return WorkflowDbController.getWorkflowHistoryChangeCountFromSnapshots(
      oldData,
      requestData,
      requestType,
    );
  }

  private static sanitizeWorkflowHistoryData(
    value: unknown,
    requestType?: string | null,
  ) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return value;
    }

    const data = { ...(value as Record<string, unknown>) };
    if (requestType === 'AUTO_GENERATE' || requestType === 'AUTO_DELETE') {
      [
        'sourceWorkflowId',
        'sourceNodeId',
        'targetNodeId',
        'parentOrgReqId',
        'sourceWorkflowReqId',
        'workflowId',
        'workflowReqId',
      ].forEach((key) => delete data[key]);
      return data;
    }

    if (requestType && requestType !== 'INITIATE') {
      delete data.target;
      delete data.subModule;
    }

    return data;
  }

  private static buildWorkflowHistoryLinkedWorkflow(history: any) {
    if (
      history?.event !== 'AUTO_GENERATE' &&
      history?.event !== 'AUTO_DELETE'
    ) {
      return null;
    }

    const data = (history.workflowReq?.data || {}) as Record<string, any>;
    const workflowId =
      typeof data.sourceWorkflowId === 'string' && data.sourceWorkflowId
        ? data.sourceWorkflowId
        : null;
    const workflowName =
      typeof data.sourceWorkflowName === 'string' && data.sourceWorkflowName
        ? data.sourceWorkflowName
        : null;
    const nodeId =
      typeof data.sourceNodeId === 'string' && data.sourceNodeId
        ? data.sourceNodeId
        : null;
    const nodeName =
      typeof data.sourceNodeName === 'string' && data.sourceNodeName
        ? data.sourceNodeName
        : null;
    const nodePath =
      typeof data.sourceNodePath === 'string' && data.sourceNodePath
        ? data.sourceNodePath
        : null;

    if (!workflowId && !workflowName && !nodeId && !nodeName && !nodePath) {
      return null;
    }

    return {
      workflowId,
      workflowName,
      nodeId,
      nodeName,
      nodePath,
    };
  }

  private static formatWorkflowHistoryRemarks(history: any) {
    if (
      history?.event !== 'AUTO_GENERATE' &&
      history?.event !== 'AUTO_DELETE'
    ) {
      return history?.remarks ?? null;
    }

    const data = (history.workflowReq?.data || {}) as Record<string, any>;
    const workflowName = data.name || 'workflow';
    const nodeName = data.nodeName || 'organization node';
    const nodePath = data.nodePath ? ` (${data.nodePath})` : '';
    const linkedWorkflow =
      WorkflowDbController.buildWorkflowHistoryLinkedWorkflow(history);
    const sourceWorkflowName = linkedWorkflow?.workflowName || null;
    const sourceNodeName = linkedWorkflow?.nodeName || null;
    const sourceNodePath = linkedWorkflow?.nodePath
      ? ` (${linkedWorkflow.nodePath})`
      : '';

    if (history?.event === 'AUTO_DELETE') {
      if (!sourceWorkflowName && !sourceNodeName) {
        return history?.remarks ?? null;
      }
      return `Auto-deleted workflow ${workflowName} for node ${nodeName}${nodePath} due to ${sourceWorkflowName} on ${sourceNodeName}${sourceNodePath}`;
    }

    if (!sourceWorkflowName && !sourceNodeName) {
      return history?.remarks ?? null;
    }

    return `Auto-generated workflow ${workflowName} for node ${nodeName}${nodePath} from ${sourceWorkflowName} on ${sourceNodeName}${sourceNodePath}`;
  }

  private static async autoGenerateExistingChildWorkflows(
    tx: any,
    params: {
      companyId: string;
      sourceWorkflow: {
        id: string;
        name: string;
        alias: string;
        module: string;
        subModule: string;
        roleCode?: string | null;
        type: string;
        levelsHash: string;
      };
      sourceNode: {
        id: string;
        nodePath: string;
        nodeName: string;
        nodeType: string;
      };
      levels: Array<{
        level: number;
        approver1: string;
        approver2?: string | null;
        approverType: string;
      }>;
      actorId: string;
      sourceWorkflowReqId: string;
    },
  ) {
    const { companyId, sourceWorkflow, sourceNode, levels, actorId } = params;
    if (sourceWorkflow.type === 'NODE') return [];

    const childWhere =
      sourceWorkflow.type === 'IMMEDIATE_CHILD'
        ? { parentId: sourceNode.id }
        : { nodePath: { startsWith: `${sourceNode.nodePath}.` } };
    const targetWorkflowType =
      sourceWorkflow.type === 'IMMEDIATE_CHILD' ? 'NODE' : sourceWorkflow.type;
    const targetNodes = await tx.orgStructure.findMany({
      where: {
        companyId,
        status: 'ACTIVE',
        ...childWhere,
      },
      select: {
        id: true,
        nodePath: true,
        nodeName: true,
        nodeType: true,
      },
    });

    const generated = [];
    for (const targetNode of targetNodes) {
      const duplicate = await tx.workflow.findUnique({
        where: {
          // eslint-disable-next-line @typescript-eslint/naming-convention -- Prisma compound unique field.
          companyId_nodeId_module_subModule_levelsHash: {
            companyId,
            nodeId: targetNode.id,
            module: sourceWorkflow.module,
            subModule: sourceWorkflow.subModule,
            levelsHash: sourceWorkflow.levelsHash,
          },
        },
        select: { id: true },
      });
      if (duplicate) continue;

      const levelsPayload = levels.reduce(
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
      const autoData = {
        name: sourceWorkflow.name,
        alias: sourceWorkflow.alias,
        workflowType: targetWorkflowType,
        module: sourceWorkflow.module,
        subModule: sourceWorkflow.subModule,
        nodePath: targetNode.nodePath,
        nodeName: targetNode.nodeName,
        nodeType: targetNode.nodeType,
        levels: levelsPayload,
        levelsHash: sourceWorkflow.levelsHash,
        roleCode: sourceWorkflow.roleCode || null,
        sourceWorkflowId: sourceWorkflow.id,
        sourceWorkflowName: sourceWorkflow.name,
        sourceWorkflowType: sourceWorkflow.type,
        sourceNodeId: sourceNode.id,
        sourceNodeName: sourceNode.nodeName,
        sourceNodePath: sourceNode.nodePath,
        targetNodeId: targetNode.id,
        targetNodePath: targetNode.nodePath,
        sourceWorkflowReqId: params.sourceWorkflowReqId,
      };

      const workflowReq = await tx.workflowReq.create({
        data: {
          companyId,
          nodeId: targetNode.id,
          module: sourceWorkflow.module,
          subModule: sourceWorkflow.subModule,
          levelsHash: sourceWorkflow.levelsHash,
          workflowId: sourceWorkflow.id,
          type: 'AUTO_GENERATE',
          impact: 'AUTO_GENERATE',
          initiatorId: actorId,
          status: 'APPROVED',
          data: autoData,
          alias: sourceWorkflow.alias,
          approvalRemark: `Auto-generated from parent workflow ${sourceWorkflow.name} for node ${targetNode.nodeName} (${targetNode.nodePath})`,
          eligibleApprovers: [],
        },
      });

      const workflow = await tx.workflow.create({
        data: {
          name: sourceWorkflow.name,
          alias: sourceWorkflow.alias,
          module: sourceWorkflow.module,
          subModule: sourceWorkflow.subModule,
          type: targetWorkflowType,
          roleCode: sourceWorkflow.roleCode || null,
          companyId,
          nodeId: targetNode.id,
          levelsHash: sourceWorkflow.levelsHash,
          workflowReqIds: [workflowReq.id],
        },
      });

      await tx.workflowReq.update({
        where: { id: workflowReq.id },
        data: { workflowId: workflow.id },
      });

      if (levels.length > 0) {
        await tx.workflowLevel.createMany({
          data: levels.map((level) => ({
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
          remarks: `Auto-generated workflow ${sourceWorkflow.name} for node ${targetNode.nodeName} (${targetNode.nodePath}) from parent workflow ${sourceWorkflow.name} on ${sourceNode.nodeName} (${sourceNode.nodePath})`,
        },
      });

      generated.push({
        workflowName: workflow.name,
        alias: workflow.alias,
        module: workflow.module,
        subModule: workflow.subModule,
        workflowType: targetWorkflowType,
        nodeName: targetNode.nodeName,
        nodePath: targetNode.nodePath,
        sourceWorkflowName: sourceWorkflow.name,
        sourceNodeName: sourceNode.nodeName,
        sourceNodePath: sourceNode.nodePath,
      });
    }

    return generated;
  }

  private static async notifyAutoGeneratedWorkflows(params: {
    companyId: string;
    sourceWorkflowReqId: string;
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
      referenceId: params.sourceWorkflowReqId,
      referenceName: generatedWorkflows[0]?.sourceWorkflowName || 'workflow',
      createdBy: params.createdBy,
      recipientUserIds,
    });
  }

  private static async assertWorkflowNotUsedInPendingApproval(
    client: any,
    workflowId: string,
    workflowName?: string,
    alias?: string,
    excludeWorkflowReqId?: string,
  ) {
    const [userRequests, orgRequests, workflowRequests] = await Promise.all([
      client.userOnboarding.findMany({
        where: { workflowId, status: 'PENDING' },
        select: { id: true, type: true, initiatorId: true },
        take: 11,
      }),
      client.orgStructureReq.findMany({
        where: { workflowId, status: 'PENDING' },
        select: { id: true, type: true, initiatorId: true },
        take: 11,
      }),
      client.workflowReq.findMany({
        where: {
          workflowId,
          status: 'PENDING',
          ...(excludeWorkflowReqId
            ? { id: { not: excludeWorkflowReqId } }
            : {}),
        },
        select: { id: true, type: true, initiatorId: true },
        take: 11,
      }),
    ]);

    const initiatorIds = Array.from(
      new Set(
        [...workflowRequests, ...userRequests, ...orgRequests]
          .map((request: any) => request.initiatorId)
          .filter((id: any): id is string => typeof id === 'string'),
      ),
    );
    const workflowInitiators =
      initiatorIds.length > 0
        ? await client.user.findMany({
            where: { id: { in: initiatorIds } },
            select: { id: true, email: true },
          })
        : [];
    const workflowInitiatorMap = new Map(
      workflowInitiators.map((user: any) => [user.id, user.email]),
    );
    const normalizeWithInitiator = (request: any) => ({
      ...request,
      initiator: {
        email: workflowInitiatorMap.get(request.initiatorId) || 'unknown',
      },
    });
    const combined = [
      ...userRequests.map(normalizeWithInitiator),
      ...orgRequests.map(normalizeWithInitiator),
      ...workflowRequests.map(normalizeWithInitiator),
    ];
    if (combined.length > 0) {
      const lines = combined
        .slice(0, 10)
        .map(
          (request: any) =>
            `- Request ID: #${request.id} | Type: ${request.type || 'N/A'} | Initiator: ${request.initiator?.email || 'unknown'}`,
        )
        .join('\n');
      const remaining = Math.max(combined.length - 10, 0);
      const remainingLine =
        remaining > 0 ? `\nand ${remaining} other request(s)...` : '';
      throw new AppError(
        `Cannot inactivate or archive workflow '${workflowName || workflowId}' (Levels: ${alias || 'N/A'}) because it is currently protecting ${combined.length} pending approval request(s). Please process these pending requests or route them to a different workflow before changing its status:\n${lines}${remainingLine}`,
        409,
      );
    }
  }

  private static async assertTargetNotPendingModification(
    client: any,
    companyId: string,
    target: WorkflowTarget,
    message = 'Workflow already has a pending modification',
    workflowDisplayName?: string | null,
  ) {
    const pendingRequests = await client.workflowReq.findMany({
      where: {
        companyId,
        status: 'PENDING',
        type: { in: ['UPDATE', 'INACTIVE', 'ARCHIVE'] },
      },
      select: {
        id: true,
        workflowId: true,
        alias: true,
        data: true,
        createdAt: true,
        initiatorId: true,
        eligibleApprovers: true,
        workflowHistories: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { event: true },
        },
      },
    });
    const effectiveIds =
      await WorkflowDbController.filterEffectivelyPendingRequestIds(
        'workflow_req',
        pendingRequests.map((request: { id: string }) => request.id),
      );
    const pendingTargetRequest = pendingRequests.find(
      (request: {
        id: string;
        workflowId: string | null;
        data: unknown;
        alias: string | null;
        initiatorId: string | null;
        createdAt: Date;
        eligibleApprovers?: string[] | null;
        workflowHistories?: Array<{ event: string }>;
      }) => {
        if (!effectiveIds.has(request.id)) return false;
        const latestEvent = request.workflowHistories?.[0]?.event;
        const hasRemainingEligibleApprovers =
          Array.isArray(request.eligibleApprovers) &&
          request.eligibleApprovers.length > 0;
        if (
          latestEvent === 'REJECTED' ||
          (latestEvent === 'APPROVED' && !hasRemainingEligibleApprovers)
        ) {
          return false;
        }
        if (target.id && request.workflowId === target.id) {
          return true;
        }
        const pendingTarget = (request.data as any)?.target;
        // Conflict matching is based on the actual target workflow identity,
        // not alias. Alias can be the same across unrelated workflows.
        return (
          pendingTarget?.module === target.module &&
          pendingTarget?.subModule === target.subModule &&
          pendingTarget?.nodePath === target.nodePath &&
          pendingTarget?.levelsHash === target.levelsHash
        );
      },
    );

    if (pendingTargetRequest) {
      if (message !== 'Workflow already has a pending modification') {
        throw new AppError(message, 409);
      }
      const pendingAlias =
        pendingTargetRequest.alias ||
        (pendingTargetRequest.data as any)?.alias ||
        pendingTargetRequest.id;
      const initiator = pendingTargetRequest.initiatorId
        ? await client.user.findUnique({
            where: { id: pendingTargetRequest.initiatorId },
            select: { name: true, email: true },
          })
        : null;
      const pendingTarget = (pendingTargetRequest.data as any)?.target || {};
      const workflowName =
        workflowDisplayName ||
        (pendingTargetRequest.data as any)?.currentData?.name ||
        (pendingTargetRequest.data as any)?.name ||
        target.levelsHash;
      throw new AppError(
        `Cannot modify, inactivate, or archive workflow '${workflowName}'. A matching workflow request '${pendingAlias}' is already pending approval for the same target: module '${pendingTarget?.module || target.module}', subModule '${pendingTarget?.subModule || target.subModule}', nodePath '${pendingTarget?.nodePath || target.nodePath}', levelsHash '${pendingTarget?.levelsHash || target.levelsHash}'. Initiated by ${initiator?.name || 'unknown'} - ${initiator?.email || 'unknown'} on ${WorkflowDbController.formatConflictDate(pendingTargetRequest.createdAt)}. Please resolve or cancel that request first.`,
        409,
      );
    }
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
      await WorkflowDbController.filterEffectivelyPendingRequestIds(
        'org_structure_req',
        pendingOrgRequests.map((request: { id: string }) => request.id),
      );
    const effectivePendingOrgRequests = pendingOrgRequests.filter(
      (request: { id: string }) => effectiveIds.has(request.id),
    );

    const blocking = effectivePendingOrgRequests.find(
      (request: { data: unknown }) => {
        const data = request.data as any;
        const targetNodePath =
          data?.targetNodePath || data?.currentData?.nodePath || data?.nodePath;
        return (
          typeof targetNodePath === 'string' && targetNodePath === nodePath
        );
      },
    );

    if (!blocking) return;
    const data = blocking.data as any;
    const initiated = blocking.orgHistories?.[0];
    const targetNodePath =
      data?.targetNodePath || data?.currentData?.nodePath || data?.nodePath;
    throw new AppError(
      `Cannot initiate or modify workflow on node '${nodePath}' because organization node '${targetNodePath}' has a pending inactivation request initiated by ${initiated?.user?.name || 'Unknown'} - ${initiated?.user?.email || 'unknown'} on ${WorkflowDbController.formatConflictDate(initiated?.createdAt || blocking.createdAt)}. Please resolve the organization request first.`,
      409,
    );
  }

  private static async createModificationRequest(input: {
    initiatorId: string;
    companyId: string;
    type: 'UPDATE' | 'INACTIVE' | 'ACTIVE' | 'ARCHIVE';
    target: WorkflowTarget;
    data: any;
    parentLevelsHash?: string | null;
    remarks?: string | null;
  }) {
    const {
      initiatorId,
      companyId,
      type,
      target: requestedTarget,
      data,
      parentLevelsHash,
      remarks,
    } = input;
    const targetNode = await prisma.orgStructure.findFirst({
      where: {
        companyId,
        nodePath: requestedTarget.nodePath,
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    const target = targetNode
      ? await prisma.workflow.findFirst({
          where: {
            companyId,
            nodeId: targetNode.id,
            module: requestedTarget.module,
            subModule: requestedTarget.subModule,
            levelsHash: requestedTarget.levelsHash,
          },
          include: {
            orgStructure: true,
            levels: { orderBy: { level: 'asc' } },
          },
        })
      : null;

    if (!target) {
      throw new AppError('Workflow not found', 404);
    }
    if (
      (type === 'UPDATE' || type === 'INACTIVE') &&
      target.status !== 'ACTIVE'
    ) {
      throw new AppError('Active workflow not found', 404);
    }
    if (type === 'ACTIVE' && target.status !== 'INACTIVE') {
      throw new AppError(`Workflow "${target.name}" is already active`, 409);
    }
    await WorkflowDbController.assertNoPendingOrgModificationForNode(
      companyId,
      requestedTarget.nodePath,
    );

    if (target.alias === '1M_1C_D' || target.name.includes('DEFAULT')) {
      throw new AppError('Default workflow cannot be modified', 400);
    }

    await WorkflowDbController.assertTargetNotPendingModification(
      prisma,
      companyId,
      { ...requestedTarget, id: target.id },
      'Workflow already has a pending modification',
      target.name,
    );

    await Promise.all([
      WorkflowDbController.assertWorkflowNotUsedInPendingApproval(
        prisma,
        target.id,
        target.name,
        target.alias,
      ),
    ]);

    const currentLevels = WorkflowDbController.toLevelsPayload(target.levels);
    const proposedLevels = data?.levels || currentLevels;
    const proposedNodePath = data?.nodePath || target.orgStructure.nodePath;
    const proposedNode = await prisma.orgStructure.findFirst({
      where: {
        companyId,
        nodePath: proposedNodePath,
        status: 'ACTIVE',
      },
    });
    if (!proposedNode) {
      throw new AppError(
        `Active node path '${proposedNodePath}' not found for this company`,
        400,
      );
    }
    await WorkflowDbController.assertNoPendingOrgModificationForNode(
      companyId,
      proposedNodePath,
    );

    const proposedLevelsHash =
      WorkflowDbController.buildLevelsHash(proposedLevels);
    const currentData = {
      name: target.name,
      module: target.module,
      subModule: target.subModule,
      nodePath: target.orgStructure.nodePath,
      workflowType: target.type,
      levels: currentLevels,
      levelsHash: target.levelsHash,
      alias: target.alias,
      status: target.status,
    };
    const newData = {
      ...currentData,
      name: data?.name || currentData.name,
      module: data?.module || currentData.module,
      subModule: data?.subModule || currentData.subModule,
      nodePath: proposedNodePath,
      workflowType:
        typeof data?.workflowType === 'string'
          ? WorkflowDbController.normalizeWorkflowType(data.workflowType)
          : currentData.workflowType,
      levels: proposedLevels,
      levelsHash: proposedLevelsHash,
      alias: WorkflowDbController.buildAlias(proposedLevels),
      status:
        type === 'INACTIVE'
          ? 'INACTIVE'
          : type === 'ACTIVE'
            ? 'ACTIVE'
            : currentData.status,
    };

    if (
      type === 'UPDATE' &&
      JSON.stringify(currentData) === JSON.stringify(newData)
    ) {
      throw new AppError('Workflow update does not change any values', 400);
    }

    const changeData = buildJsonPatch(currentData, newData);

    const duplicateActive = await prisma.workflow.findUnique({
      where: {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- Prisma compound unique field.
        companyId_nodeId_module_subModule_levelsHash: {
          companyId,
          nodeId: proposedNode.id,
          module: newData.module,
          subModule: newData.subModule,
          levelsHash: newData.levelsHash,
        },
      },
      select: { id: true, name: true },
    });
    if (duplicateActive && duplicateActive.id !== target.id) {
      throw new AppError(`Already active: "${duplicateActive.name}"`, 409);
    }

    const duplicatePending = await prisma.workflowReq.findFirst({
      where: {
        companyId,
        nodeId: proposedNode.id,
        module: newData.module,
        subModule: newData.subModule,
        levelsHash: newData.levelsHash,
        alias: newData.alias,
        status: 'PENDING',
      },
      select: { id: true },
    });
    if (duplicatePending) {
      throw new AppError('A matching workflow request is already pending', 409);
    }

    const requestData = {
      target: requestedTarget,
      ...(data || {}),
      ...(type === 'INACTIVE'
        ? { status: 'INACTIVE' }
        : type === 'ACTIVE'
          ? { status: 'ACTIVE' }
          : type === 'ARCHIVE'
            ? { status: 'ARCHIVE' }
            : {}),
    };
    const persistedType = type === 'ACTIVE' ? 'UPDATE' : type;
    let notificationRecipients: string[] = [];
    const request = await prisma.$transaction(async (tx) => {
      const created = await tx.workflowReq.create({
        data: {
          companyId,
          nodeId: proposedNode.id,
          module: newData.module,
          subModule: newData.subModule,
          levelsHash: newData.levelsHash,
          workflowId: target.id,
          type: persistedType,
          impact:
            type === 'INACTIVE'
              ? 'INACTIVE'
              : type === 'ACTIVE'
                ? 'ACTIVE'
                : type === 'ARCHIVE'
                  ? 'ARCHIVE'
                  : 'WORKFLOW_UPDATE',
          initiatorId,
          data: requestData as any,
          oldData: changeData?.oldData as any,
          alias: newData.alias,
          approvalRemark: remarks || null,
          eligibleApprovers: [],
        },
      });
      const approval = await WorkflowApproverUtil.resolveAndCreateApprovers(
        tx,
        {
          levelsHash: parentLevelsHash || null,
          module: 'SYSTEM_ACCESS',
          subModule: 'WORK_FLOW',
          companyId,
          nodeId: proposedNode.id,
          initiatorId,
          reqId: created.id,
          reqTable: 'workflow_req',
        },
      );
      notificationRecipients = approval.eligibleApprovers;
      const requestWithApprovalWorkflow = await tx.workflowReq.update({
        where: { id: created.id },
        data: { approvalWorkflowId: approval.workflowId },
      });
      await tx.workflowReqHistory.create({
        data: {
          workflowReqId: created.id,
          companyId,
          event: 'INITIATE',
          eventUserId: initiatorId,
          remarks: remarks || null,
        },
      });
      return requestWithApprovalWorkflow;
    });

    const modificationNotification =
      WorkflowDbController.getWorkflowNotificationContent(
        type,
        'initiated',
        newData.name,
      );
    await NotificationService.createRequestNotification({
      companyId,
      type: WorkflowDbController.getWorkflowNotificationType(type, 'PENDING'),
      name: modificationNotification.name,
      message: modificationNotification.message,
      referenceType: 'WORKFLOW',
      referenceId: request.id,
      referenceName: newData.name,
      createdBy: initiatorId,
      recipientUserIds: NotificationService.mergeRecipientUserIds(
        notificationRecipients,
        await NotificationService.getCorpAdminUserIds(companyId),
      ),
      includeCreatedBy: true,
    });

    return request;
  }

  private static async assertFinalApproversRemainEligible(
    client: any,
    requestId: string,
    companyId: string,
  ) {
    const rows = await client.workflowApprover.findMany({
      where: { reqId: requestId, reqTable: 'workflow_req' },
      select: { approversList: true },
    });
    const approverIds = Array.from(
      new Set(
        rows.flatMap((row: any) =>
          Array.isArray(row.approversList) ? row.approversList : [],
        ),
      ),
    ) as string[];

    if (approverIds.length === 0) return;

    const [approverUsers, pendingAccessRemovalRequests] = await Promise.all([
      client.user.findMany({
        where: { id: { in: approverIds } },
        select: { email: true },
      }),
      client.userOnboarding.findMany({
        where: {
          companyId,
          status: 'PENDING',
          OR: [
            { type: { in: ['INACTIVE', 'ARCHIVE'] } },
            { impact: 'DOWNGRADE' },
          ],
        },
        select: { data: true },
      }),
    ]);
    const approverEmails = new Set(
      approverUsers.map((user: any) => user.email),
    );
    const pendingAccessRemoval = pendingAccessRemovalRequests.some(
      (request: any) =>
        approverEmails.has((request.data as any)?.targetUserEmail),
    );

    if (pendingAccessRemoval) {
      throw new AppError(
        'An eligible workflow approver has a pending downgrade or deactivation request',
        409,
      );
    }
  }

  private static async applyApprovedModification(
    tx: any,
    request: any,
    remark?: string | null,
  ) {
    const requestData = request.data as any;
    const requestedTarget = requestData.target;
    if (!requestedTarget) {
      throw new AppError(
        'Target workflow is missing from modification request',
        400,
      );
    }

    const originalNode = await tx.orgStructure.findFirst({
      where: {
        companyId: request.companyId,
        nodePath: requestedTarget.nodePath,
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    const target = originalNode
      ? await tx.workflow.findFirst({
          where: {
            companyId: request.companyId,
            nodeId: originalNode.id,
            module: requestedTarget.module,
            subModule: requestedTarget.subModule,
            levelsHash: requestedTarget.levelsHash,
          },
          include: {
            levels: { orderBy: { level: 'asc' } },
            orgStructure: { select: { nodePath: true } },
          },
        })
      : null;
    if (!target) {
      throw new AppError('Target workflow no longer exists', 409);
    }
    const requestedStatus = String(requestData?.status || '').toUpperCase();
    const isActivation = requestedStatus === 'ACTIVE';
    const isInactivation =
      request.type === 'INACTIVE' || requestedStatus === 'INACTIVE';
    const isArchive =
      request.type === 'ARCHIVE' || requestedStatus === 'ARCHIVE';
    const isStatusTransition = isActivation || isInactivation || isArchive;
    let approvedRequestIdentity: Record<string, unknown> | null = null;

    if (target.status === 'ARCHIVE' && !isArchive) {
      throw new AppError(
        `Workflow "${target.name}" is deleted and cannot be modified`,
        409,
      );
    }
    if (isActivation && target.status !== 'INACTIVE') {
      throw new AppError(`Workflow "${target.name}" is already active`, 409);
    }
    if (isInactivation && target.status !== 'ACTIVE') {
      throw new AppError(`Workflow "${target.name}" is already inactive`, 409);
    }
    if (isArchive && target.status === 'ARCHIVE') {
      throw new AppError(`Workflow "${target.name}" is already archived`, 409);
    }
    if (!isStatusTransition && target.status !== 'ACTIVE') {
      throw new AppError('Active target workflow no longer exists', 409);
    }

    const parentMap = await WorkflowDbController.getAutoGeneratedParentMap(
      tx,
      request.companyId,
    );
    const descendantIds = WorkflowDbController.collectWorkflowDescendantIds(
      parentMap,
      target.id,
    );
    const workflowIds = [target.id, ...descendantIds];
    const familyWorkflows = await tx.workflow.findMany({
      where: { id: { in: workflowIds } },
      include: {
        levels: { orderBy: { level: 'asc' } },
        orgStructure: { select: { nodePath: true } },
      },
    });

    await Promise.all([
      WorkflowDbController.assertFinalApproversRemainEligible(
        tx,
        request.id,
        request.companyId,
      ),
      ...familyWorkflows.map((workflow: any) =>
        WorkflowDbController.assertWorkflowNotUsedInPendingApproval(
          tx,
          workflow.id,
          workflow.name,
          workflow.alias,
          request.id,
        ),
      ),
    ]);

    if (isStatusTransition) {
      const nextStatus = isActivation
        ? 'ACTIVE'
        : isInactivation
          ? 'INACTIVE'
          : 'ARCHIVE';
      await Promise.all(
        familyWorkflows.map((workflow: any) =>
          tx.workflow.update({
            where: { id: workflow.id },
            data: {
              status: nextStatus,
              workflowReqIds: { push: request.id },
            },
          }),
        ),
      );
    } else {
      const currentLevels = WorkflowDbController.toLevelsPayload(target.levels);
      const proposedLevels = requestData?.levels || currentLevels;
      const proposedNodePath =
        requestData?.nodePath || requestedTarget.nodePath;
      const nextData = {
        name: requestData?.name || target.name,
        module: requestData?.module || target.module,
        subModule: requestData?.subModule || target.subModule,
        nodePath: proposedNodePath,
        workflowType:
          typeof requestData?.workflowType === 'string'
            ? WorkflowDbController.normalizeWorkflowType(
                requestData.workflowType,
              )
            : target.type,
        levels: proposedLevels,
        levelsHash: WorkflowDbController.buildLevelsHash(proposedLevels),
        alias: WorkflowDbController.buildAlias(proposedLevels),
      };
      const node = await tx.orgStructure.findFirst({
        where: {
          companyId: request.companyId,
          nodePath: nextData.nodePath,
          status: 'ACTIVE',
        },
      });
      if (!node) {
        throw new AppError('Workflow node is no longer active', 409);
      }

      const calculatedHash = WorkflowDbController.buildLevelsHash(
        nextData.levels,
      );
      if (calculatedHash !== nextData.levelsHash) {
        throw new AppError('Workflow level hash is invalid', 409);
      }

      const duplicateActive = await tx.workflow.findUnique({
        where: {
          // eslint-disable-next-line @typescript-eslint/naming-convention -- Prisma compound unique field.
          companyId_nodeId_module_subModule_levelsHash: {
            companyId: request.companyId,
            nodeId: node.id,
            module: nextData.module,
            subModule: nextData.subModule,
            levelsHash: calculatedHash,
          },
        },
        select: { id: true, name: true },
      });
      if (duplicateActive && duplicateActive.id !== target.id) {
        throw new AppError(`Already active: "${duplicateActive.name}"`, 409);
      }

      const roleRecord = await tx.roles.findFirst({
        where: {
          category: nextData.module,
          subCategory: nextData.subModule,
          permissionLevel: 'MANAGER',
        },
      });
      await Promise.all(
        familyWorkflows.map(async (workflow: any) => {
          if (workflow.status === 'ARCHIVE') return;
          await tx.workflow.update({
            where: { id: workflow.id },
            data: {
              name: nextData.name,
              alias: nextData.alias,
              module: nextData.module,
              subModule: nextData.subModule,
              roleCode: roleRecord?.roleCode || null,
              nodeId: workflow.id === target.id ? node.id : workflow.nodeId,
              type: nextData.workflowType,
              levelsHash: calculatedHash,
              workflowReqIds: { push: request.id },
            },
          });
          await tx.workflowLevel.deleteMany({
            where: { workflowId: workflow.id },
          });

          const levelData = Object.entries(nextData.levels || {})
            .filter(([, level]) => Boolean(level))
            .map(([key, level]) => {
              const configured = level as any;
              return {
                workflowId: workflow.id,
                level: parseInt(key.replace('l', ''), 10),
                approver1: configured.approver1,
                approver2: configured.approver2 || null,
                approverType: configured.type || 'OR',
              };
            });
          if (levelData.length > 0) {
            await tx.workflowLevel.createMany({ data: levelData });
          }
        }),
      );
      approvedRequestIdentity = {
        nodeId: node.id,
        module: nextData.module,
        subModule: nextData.subModule,
        levelsHash: calculatedHash,
        alias: nextData.alias,
      };
    }

    return tx.workflowReq.update({
      where: { id: request.id },
      data: {
        status: 'APPROVED',
        approvalRemark: remark,
        ...(approvedRequestIdentity || {}),
      },
    });
  }

  // --- Internal Atomic Operations ---

  /**
   * Fetches a single workflow request by its unique ID.
   * Includes the associated company details for context.
   */
  static async getWorkflowRequestByHash(req: Request, res: Response) {
    const { id, levelsHash, companyId, module, subModule, alias, nodePath } =
      req.body;
    let nodeId: string | undefined;
    if (nodePath) {
      const node = await prisma.orgStructure.findFirst({
        where: { companyId, nodePath, status: 'ACTIVE' },
        select: { id: true },
      });
      nodeId = node?.id;
    }
    const request = await prisma.workflowReq.findFirst({
      where: {
        ...(id
          ? { id }
          : {
              levelsHash,
              module: module || undefined,
              subModule: subModule || undefined,
              alias: alias || undefined,
              nodeId: nodeId || undefined,
            }),
        companyId,
        status: 'PENDING',
      },
      include: { company: true },
    });
    res.json(request);
  }

  // --- Transactional Commit Operations ---

  /**
   * Initiates a new workflow onboarding request.
   * Performs an atomic transaction to:
   * 1. Create a WorkflowReq entry with the provided payload and eligible approvers.
   * 2. Resolve the workflow (explicit or default for WORK_FLOW section).
   * 3. Build WorkflowApprover rows for each approval level.
   * 4. Log the 'INITIATE' event in the WorkflowReqHistory table.
   */
  static async initiateWorkflowRequest(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const {
        initiatorId,
        companyCode,
        companyId,
        data,
        eligibleApprovers,
        levelsHash: parentLevelsHash,
        type = 'INITIATE',
        target,
        remarks,
      } = req.body;

      if (!initiatorId) {
        throw new AppError('initiatorId is required', 400);
      }

      let resolvedCompanyId = companyId;

      if (!resolvedCompanyId) {
        if (!companyCode) {
          throw new AppError('companyCode or companyId is required', 400);
        }
        // Resolve Company ID
        const company = await prisma.company.findUnique({
          where: { companyCode },
        });
        if (!company) throw new AppError('Company not found', 404);
        resolvedCompanyId = company.id;
      }

      if (
        type === 'UPDATE' ||
        type === 'INACTIVE' ||
        type === 'ACTIVE' ||
        type === 'ARCHIVE'
      ) {
        if (!target) {
          throw new AppError('Workflow target details are required', 400);
        }

        try {
          const request = await WorkflowDbController.createModificationRequest({
            initiatorId,
            companyId: resolvedCompanyId,
            type,
            target,
            data,
            parentLevelsHash,
            remarks,
          });
          return res.status(201).json(request);
        } catch (error) {
          const globalAccesses = await prisma.userAccess.findMany({
            where: { companyId: resolvedCompanyId, isGlobalAccess: true },
            select: { userId: true },
          });
          const recipients = NotificationService.mergeRecipientUserIds(
            initiatorId,
            req.body?.eligibleApprovers,
            globalAccesses.map((access) => access.userId),
          );
          const requiredRecipients = NotificationService.mergeRecipientUserIds(
            initiatorId,
            req.body?.eligibleApprovers,
          );
          await NotificationService.createRequestNotification({
            companyId: resolvedCompanyId,
            type: 'MODIFICATION',
            name: 'Workflow modification blocked',
            message:
              error instanceof Error
                ? error.message
                : 'Workflow modification request was blocked',
            referenceType: 'WORKFLOW',
            referenceId: target.levelsHash,
            referenceName: data?.name || 'workflow modification',
            createdBy: initiatorId,
            recipientUserIds: recipients,
            requiredRecipientUserIds: requiredRecipients,
            includeCreatedBy: true,
          }).catch(() => undefined);
          throw error;
        }
      }

      const workflowType = WorkflowDbController.normalizeWorkflowType(
        data?.workflowType,
      );
      const workflowData = { ...(data || {}), workflowType };
      delete workflowData.type;
      const { module, subModule, nodePath, levels } = workflowData;
      await WorkflowDbController.assertNoPendingOrgModificationForNode(
        resolvedCompanyId,
        nodePath,
      );

      // 1. Resolve Node ID
      const node = await prisma.orgStructure.findFirst({
        where: { nodePath, companyId: resolvedCompanyId, status: 'ACTIVE' },
      });
      if (!node)
        throw new AppError(
          `Active node path '${nodePath}' not found for this company`,
          400,
        );

      const nodeId = node.id;
      const levelsHash = WorkflowDbController.buildLevelsHash(levels);
      const generatedAlias = WorkflowDbController.buildAlias(levels);

      // 2. Block if duplicate exists on the same unique workflow identity.
      // If an inactive record exists, callers must modify/reactivate it instead
      // of creating a brand new INITIATE workflow request.
      const existingWorkflow = await prisma.workflow.findUnique({
        where: {
          // eslint-disable-next-line @typescript-eslint/naming-convention -- Prisma compound unique field.
          companyId_nodeId_module_subModule_levelsHash: {
            companyId: resolvedCompanyId,
            nodeId,
            module,
            subModule,
            levelsHash,
          },
        },
        select: { id: true, name: true, status: true },
      });
      if (existingWorkflow?.status === 'ACTIVE') {
        throw new AppError(`Already active: "${existingWorkflow.name}"`, 409);
      }
      if (existingWorkflow) {
        throw new AppError(
          `Workflow "${existingWorkflow.name}" already exists with status ${existingWorkflow.status}. Please modify the existing workflow instead of initiating a new one.`,
          409,
        );
      }

      // 3. Block if PENDING duplicate exists
      const alreadyPending = await prisma.workflowReq.findFirst({
        where: {
          companyId: resolvedCompanyId,
          nodeId,
          module,
          subModule,
          levelsHash,
          alias: generatedAlias,
          status: 'PENDING',
        },
      });
      if (alreadyPending) {
        throw new AppError(
          `Already pending: "${WorkflowDbController.getWorkflowRequestDisplayName(alreadyPending)}"`,
          409,
        );
      }

      // Fetch all global access users for this company to ensure they are in the master eligible list
      const globalUsers = await WorkflowApproverUtil.getGlobalAccessUserIds(
        prisma as any,
        resolvedCompanyId,
        'WORK_FLOW',
      );

      // Master eligible list includes both configured and global approvers.
      // Initiator is excluded from all active approval lists.
      const masterEligible = new Set([
        ...(eligibleApprovers || []),
        ...globalUsers,
      ]);
      const filteredApprovers = Array.from(masterEligible).filter(
        (id) => id !== initiatorId,
      );
      let notificationRecipients = filteredApprovers;

      const result = await prisma.$transaction(async (tx) => {
        const request = await tx.workflowReq.create({
          data: {
            companyId: resolvedCompanyId,
            nodeId,
            module,
            subModule,
            levelsHash,
            type: 'INITIATE',
            initiatorId,
            data: workflowData,
            alias: generatedAlias,
            status: 'PENDING',
            eligibleApprovers: filteredApprovers,
          },
          include: { company: true },
        });

        // ── Resolve workflow approvers and create WorkflowApprover rows ──────
        if (initiatorId) {
          const {
            workflowId: resolvedWorkflowId,
            eligibleApprovers: resolvedApprovers,
          } = await WorkflowApproverUtil.resolveAndCreateApprovers(tx, {
            levelsHash: parentLevelsHash || null,
            module: 'SYSTEM_ACCESS',
            subModule: 'WORK_FLOW',
            companyId: resolvedCompanyId,
            nodeId,
            initiatorId,
            reqId: request.id,
            reqTable: 'workflow_req',
          });
          notificationRecipients = resolvedApprovers;

          // Keep workflowId for the business workflow; store approval config separately.
          await tx.workflowReq.update({
            where: { id: request.id },
            data: { approvalWorkflowId: resolvedWorkflowId },
          });
        }

        // Record the initiation in history for auditing
        await tx.workflowReqHistory.create({
          data: {
            workflowReqId: request.id,
            companyId: resolvedCompanyId,
            event: 'INITIATE',
            eventUserId: initiatorId,
          },
        });

        return request;
      });

      await NotificationService.createRequestNotification({
        companyId: resolvedCompanyId,
        type: 'INITIATE',
        referenceType: 'WORKFLOW',
        referenceId: result.id,
        referenceName: workflowData?.name,
        createdBy: initiatorId,
        recipientUserIds: NotificationService.mergeRecipientUserIds(
          notificationRecipients,
          await NotificationService.getCorpAdminUserIds(resolvedCompanyId),
        ),
        includeCreatedBy: true,
      });

      res.status(201).json(result);
    } catch (error) {
      const initiatorId = req.body?.initiatorId;
      const refName =
        req.body?.data?.name || req.body?.target?.levelsHash || 'workflow';
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
        await WorkflowDbController.notifyConflict(
          resolvedCompanyId,
          initiatorId,
          error instanceof Error ? error.message : 'Unexpected error',
          String(refName),
          req.body?.target?.levelsHash || null,
          NotificationService.mergeRecipientUserIds(
            req.body?.eligibleApprovers,
          ),
        );
      }
      next(error);
    }
  }

  /**
   * Processes an action (APPROVE/REJECT) on a pending workflow request.
   * Level-wise Approval Flow:
   * 1. Checks the current pending level from WorkflowApprover.
   * 2. Verifies the approver is in the current level's approversList.
   * 3. For APPROVE: marks level as APPROVED, only commits the workflow if all levels pass.
   * 4. For REJECT: marks all levels REJECTED.
   * 5. Logs level-wise events in WorkflowReqHistory.
   */
  static async actionWorkflowRequest(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const {
        id: requestId,
        levelsHash,
        companyId,
        status,
        approverId,
        remark,
        module,
        subModule,
        alias,
        nodePath,
      } = req.body;
      let nodeId: string | undefined;
      if (nodePath) {
        const node = await prisma.orgStructure.findFirst({
          where: { companyId, nodePath },
          select: { id: true },
        });
        nodeId = node?.id;
      }

      // ── Find the pending request by levelsHash ──────────────────────────
      const request = await prisma.workflowReq.findFirst({
        where: {
          ...(requestId
            ? { id: requestId }
            : {
                levelsHash,
                module: module || undefined,
                subModule: subModule || undefined,
                alias: alias || undefined,
                nodeId: nodeId || undefined,
              }),
          companyId,
          status: 'PENDING',
        },
        include: { company: true },
      });

      if (!request)
        throw new AppError(
          'Workflow request not found or already processed',
          404,
        );
      if (request.initiatorId && request.initiatorId === approverId) {
        throw new AppError('Initiator cannot approve their own request', 403);
      }
      const id = request.id;
      let notificationRecipients = request.eligibleApprovers || [];
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
        'workflow_req',
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
        const statusStr = status.toString().toLowerCase();

        // --- Prevent Self-Approval ---
        // Block the initiator from approving their own request.
        const initiatorLog = await tx.workflowReqHistory.findFirst({
          where: { workflowReqId: id, event: 'INITIATE' },
        });
        if (
          request.initiatorId === approverId ||
          (initiatorLog && initiatorLog.eventUserId === approverId)
        ) {
          throw new AppError('Initiator cannot approve their own request', 403);
        }

        // --- Prevent Double Approval ---
        const alreadyApproved = await WorkflowApproverUtil.isAlreadyApproved(
          tx,
          id,
          'workflow_req',
          approverId,
        );
        if (alreadyApproved) {
          throw new AppError(
            'You have already approved this request once',
            403,
          );
        }
        // --- REJECT FLOW ---
        // Marks the request as REJECTED, rejects all levels, and logs the history.
        if (statusStr === 'reject' || statusStr === 'rejected') {
          // Reject all remaining approval levels
          await WorkflowApproverUtil.rejectAllLevels(tx, id, 'workflow_req');

          const updated = await tx.workflowReq.update({
            where: { id },
            data: {
              status: 'REJECTED',
              approvalRemark: remark,
            },
          });

          await tx.workflowReqHistory.create({
            data: {
              workflowReqId: id,
              companyId: request.companyId,
              event: 'REJECTED',
              eventUserId: approverId,
              level: currentLevel?.level || null,
              remarks: remark,
            },
          });

          return { ...updated, status: 'REJECTED' };
        }

        // --- APPROVE FLOW ---
        // Converts the request into an active Workflow and setup its approval levels.
        if (statusStr === 'approve' || statusStr === 'approved') {
          // ── Level-wise approval: mark current level as APPROVED ──────────
          let allLevelsApproved = true;
          const approvedLevel = currentLevel?.level || null;

          if (currentLevel) {
            const nextLevel = await WorkflowApproverUtil.approveLevel(
              tx,
              id,
              'workflow_req',
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
          await tx.workflowReqHistory.create({
            data: {
              workflowReqId: id,
              companyId: request.companyId,
              event: 'APPROVED',
              eventUserId: approverId,
              level: approvedLevel,
              remarks: remark,
            },
          });

          // If NOT all levels approved, return early (partial approval)
          if (!allLevelsApproved) {
            return {
              id: request.id,
              status: 'PARTIAL_APPROVED',
              level: approvedLevel,
            };
          }

          const requestType = String(request.type || '').toUpperCase();
          if (
            requestType === 'UPDATE' ||
            requestType === 'INACTIVE' ||
            requestType === 'ARCHIVE'
          ) {
            const updated =
              await WorkflowDbController.applyApprovedModification(
                tx,
                request,
                remark,
              );
            return { ...updated, status: 'APPROVED' };
          }

          // ── DUPLICATE CHECKS (only for full approval) ──────────────────
          const { companyId, nodeId, module, subModule, levelsHash } = request;

          // Block if duplicate exists on the same unique workflow identity.
          const existingWorkflow = await tx.workflow.findUnique({
            where: {
              // eslint-disable-next-line @typescript-eslint/naming-convention -- Prisma compound unique field.
              companyId_nodeId_module_subModule_levelsHash: {
                companyId,
                nodeId,
                module,
                subModule,
                levelsHash,
              },
            },
            select: { id: true, name: true, status: true },
          });
          if (existingWorkflow?.status === 'ACTIVE') {
            throw new AppError(
              `Already active: "${existingWorkflow.name}"`,
              409,
            );
          }
          if (existingWorkflow) {
            throw new AppError(
              `Workflow "${existingWorkflow.name}" already exists with status ${existingWorkflow.status}. Please modify the existing workflow instead of initiating a new one.`,
              409,
            );
          }

          // Block if OTHER PENDING duplicates exist
          const alreadyPending = await tx.workflowReq.findFirst({
            where: {
              companyId,
              nodeId,
              module,
              subModule,
              levelsHash,
              alias: request.alias || undefined,
              status: 'PENDING',
              id: { not: id },
            },
          });
          if (alreadyPending) {
            throw new AppError(
              `Already pending: "${WorkflowDbController.getWorkflowRequestDisplayName(alreadyPending)}"`,
              409,
            );
          }

          // ── All levels approved — proceed with production workflow creation ──
          const reqData = request.data as any;
          const {
            name,
            module: reqModule,
            subModule: reqSubModule,
            nodePath,
            levels,
          } = reqData;
          const workflowType = WorkflowDbController.normalizeWorkflowType(
            reqData?.workflowType,
          );

          // 1. Resolve the organizational node from the path
          const nodeRecord = await tx.orgStructure.findUnique({
            where: { nodePath },
          });

          if (!nodeRecord) throw new Error(`Node path '${nodePath}' not found`);

          // Fetch the corresponding roleCode for the module and subModule
          const roleRecord = await tx.roles.findFirst({
            where: {
              category: reqModule,
              subCategory: reqSubModule,
              permissionLevel: 'MANAGER',
            },
          });

          // 2. Generate Workflow Alias: 1M_{TotalApprovers}C_{TotalLevels}
          let totalApprovers = 0;
          let totalLevels = 0;
          if (levels) {
            for (const level of Object.values(levels)) {
              if (level) {
                totalLevels++;
                const l = level as any;
                if (l.approver2 && l.type === 'AND') {
                  totalApprovers += 2;
                } else {
                  totalApprovers += 1;
                }
              }
            }
          }
          const generatedAlias = `1M_${totalApprovers}C_${totalLevels}`;

          // 3. Create the production Workflow record
          const workflow = await tx.workflow.create({
            data: {
              name,
              alias: generatedAlias,
              module: reqModule,
              subModule: reqSubModule,
              roleCode: roleRecord?.roleCode || null,
              companyId: request.companyId,
              nodeId: nodeRecord.id,
              type: workflowType,
              levelsHash: request.levelsHash,
              workflowReqIds: [id],
            },
          });

          // 4. Create the specific Approval Levels for this workflow
          const levelData = [];
          if (levels) {
            for (const [key, level] of Object.entries(levels)) {
              if (level) {
                const l = level as any;
                levelData.push({
                  workflowId: workflow.id,
                  level: parseInt(key.replace('l', '')),
                  approver1: l.approver1,
                  approver2: l.approver2 || null,
                  approverType: l.type || 'OR',
                });
              }
            }
          }
          if (levelData.length > 0) {
            await tx.workflowLevel.createMany({ data: levelData });
          }

          await tx.workflowReq.update({
            where: { id },
            data: {
              workflowId: workflow.id,
            },
          });

          // 5. Finalize the request status
          const updated = await tx.workflowReq.update({
            where: { id },
            data: {
              status: 'APPROVED',
              approvalRemark: remark,
            },
          });

          autoGeneratedWorkflowNotifications =
            await WorkflowDbController.autoGenerateExistingChildWorkflows(tx, {
              companyId: request.companyId,
              sourceWorkflow: workflow,
              sourceNode: nodeRecord,
              levels: levelData,
              actorId: approverId,
              sourceWorkflowReqId: id,
            });

          return { ...updated, status: 'APPROVED' };
        }

        throw new Error('Invalid status');
      });

      const requestType = String(request.type || 'INITIATE').toUpperCase();
      let message = `Workflow request ${status.toLowerCase()}ed successfully`;
      if (result && result.status === 'PARTIAL_APPROVED') {
        message = `Workflow request approved at Level ${result.level}, pending remaining approval`;
      } else if (result && result.status === 'APPROVED') {
        message =
          requestType === 'INITIATE'
            ? 'Workflow initiate request approved and activated'
            : requestType === 'UPDATE'
              ? 'Workflow update request approved'
              : requestType === 'INACTIVE' ||
                  ((request.data as any)?.status === 'INACTIVE' &&
                    requestType === 'UPDATE')
                ? 'Workflow inactivation request approved'
                : requestType === 'ARCHIVE' ||
                    (request.data as any)?.status === 'ARCHIVE'
                  ? 'Workflow archive request approved'
                  : requestType === 'UPDATE' &&
                      (request.data as any)?.status === 'ACTIVE'
                    ? 'Workflow activation request approved'
                    : 'Workflow update request approved';
      } else if (result && result.status === 'REJECTED') {
        message = `Workflow ${requestType.toLowerCase()} request rejected`;
      }

      if (result?.status === 'PARTIAL_APPROVED') {
        notificationRecipients =
          await NotificationService.getCurrentApproverIds(
            id,
            'workflow_req',
            notificationRecipients,
          );
      }

      const requestInitiatorId =
        await NotificationService.getRequestInitiatorId(id, 'workflow_req');
      const corpAdminUserIds = await NotificationService.getCorpAdminUserIds(
        request.companyId,
      );
      const notificationRecipientUserIds =
        NotificationService.mergeRecipientUserIds(
          notificationRecipients,
          requestInitiatorId,
        );
      const workflowReferenceName =
        (request.data as any)?.name || request.alias || request.id;
      const workflowNotificationRequestType =
        request.impact === 'ACTIVE'
          ? 'ACTIVE'
          : request.impact === 'INACTIVE'
            ? 'INACTIVE'
            : request.impact === 'ARCHIVE'
              ? 'ARCHIVE'
              : request.type;
      const workflowNotificationContent =
        requestType !== 'INITIATE' && result?.status
          ? WorkflowDbController.getWorkflowNotificationContent(
              workflowNotificationRequestType,
              result.status === 'REJECTED' ? 'rejected' : 'approved',
              workflowReferenceName,
            )
          : null;

      await NotificationService.createRequestNotification({
        companyId: request.companyId,
        type: WorkflowDbController.getWorkflowNotificationType(
          workflowNotificationRequestType,
          result?.status,
        ),
        ...(workflowNotificationContent || {}),
        referenceType: 'WORKFLOW',
        referenceId: request.id,
        referenceName: workflowReferenceName,
        createdBy: approverId,
        recipientUserIds: NotificationService.mergeRecipientUserIds(
          notificationRecipientUserIds,
          corpAdminUserIds,
        ),
        requiredRecipientUserIds:
          NotificationService.mergeRecipientUserIds(requestInitiatorId),
        isPending: result?.status === 'PARTIAL_APPROVED',
      });

      if (
        result?.status === 'APPROVED' &&
        requestType === 'INITIATE' &&
        autoGeneratedWorkflowNotifications.length > 0
      ) {
        await WorkflowDbController.notifyAutoGeneratedWorkflows({
          companyId: request.companyId,
          sourceWorkflowReqId: request.id,
          createdBy: approverId,
          generatedWorkflows: autoGeneratedWorkflowNotifications,
        });
      }

      res.status(200).json({
        message,
        data: result,
      });
    } catch (error) {
      const requestId = req.body?.id;
      const companyId = req.body?.companyId;
      const initiatorId =
        typeof requestId === 'string' && typeof companyId === 'string'
          ? await NotificationService.getRequestInitiatorId(
              requestId,
              'workflow_req',
            )
          : null;

      if (
        initiatorId &&
        typeof companyId === 'string' &&
        typeof requestId === 'string'
      ) {
        const requestApproverIds =
          await NotificationService.getRequestApproverIds(
            requestId,
            'workflow_req',
          );
        const corpAdminUserIds =
          await NotificationService.getCorpAdminUserIds(companyId);
        const recipients = NotificationService.mergeRecipientUserIds(
          initiatorId,
          requestApproverIds,
          corpAdminUserIds,
        );
        await NotificationService.createRequestNotification({
          companyId,
          type: 'MODIFICATION',
          name: 'Workflow request failed',
          message: `Workflow request failed: ${
            error instanceof Error ? error.message : 'Unexpected error'
          }`,
          referenceType: 'WORKFLOW',
          referenceId: requestId,
          referenceName:
            req.body?.data?.name ||
            req.body?.alias ||
            req.body?.target?.levelsHash ||
            'workflow',
          createdBy: initiatorId,
          recipientUserIds: recipients,
          requiredRecipientUserIds: NotificationService.mergeRecipientUserIds(
            initiatorId,
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
   * Retrieves the audit history for workflows.
   * Can be filtered by a specific workflowId (resolves all associated requests)
   * or by companyCode for a general company audit trail.
   */

  static async fetchWorkflowHistory(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const {
        companyCode,
        companyId,
        id,
        levelsHash,
        module,
        subModule,
        nodePath,
        userId,
      } = req.body;
      let whereCondition: any = {};
      let historyIdentityFilter: WorkflowHistoryIdentityFilter | null = null;

      let resolvedCompanyId = companyId;
      if (!resolvedCompanyId && companyCode) {
        const company = await prisma.company.findUnique({
          where: { companyCode },
        });
        if (!company) throw new AppError('Company not found', 404);
        resolvedCompanyId = company.id;
      }

      if (!resolvedCompanyId) {
        return res
          .status(400)
          .json({ error: 'companyCode, companyId or levelsHash is required' });
      }
      if (levelsHash && !id && (!module || !subModule || !nodePath)) {
        throw new AppError(
          'module, subModule and nodePath are required when fetching workflow history by levelsHash',
          400,
        );
      }

      // Check if requester is a global access user
      let isGlobal = true;
      let userNodeIds: string[] = [];

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
          const accesses = await prisma.userAccess.findMany({
            where: { userId, companyId: resolvedCompanyId },
            select: { nodeId: true },
          });
          userNodeIds = accesses.map((a) => a.nodeId);
        }
      }

      const nodeAccessFilter = isGlobal ? {} : { nodeId: { in: userNodeIds } };
      const historyLookupId = WorkflowDbController.normalizeHistoryLookupId(id);

      if (typeof historyLookupId === 'string' && historyLookupId) {
        const directRequest = await prisma.workflowReq.findFirst({
          where: {
            id: historyLookupId,
            companyId: resolvedCompanyId,
            ...nodeAccessFilter,
          },
          select: { id: true, workflowId: true },
        });

        const requestIds = new Set<string>();
        if (directRequest) {
          requestIds.add(directRequest.id);
          if (directRequest.workflowId) {
            const familyWorkflowRequestIds =
              await WorkflowDbController.getWorkflowFamilyRequestIds(
                prisma,
                resolvedCompanyId,
                directRequest.workflowId,
                nodeAccessFilter,
              );
            familyWorkflowRequestIds.forEach((requestId) =>
              requestIds.add(requestId),
            );
          }
        } else {
          const directHistory = await prisma.workflowReqHistory.findFirst({
            where: {
              id: historyLookupId,
              companyId: resolvedCompanyId,
            },
            select: {
              workflowReq: {
                select: {
                  id: true,
                  workflowId: true,
                },
              },
            },
          });

          if (directHistory?.workflowReq) {
            requestIds.add(directHistory.workflowReq.id);
            if (directHistory.workflowReq.workflowId) {
              const familyWorkflowRequestIds =
                await WorkflowDbController.getWorkflowFamilyRequestIds(
                  prisma,
                  resolvedCompanyId,
                  directHistory.workflowReq.workflowId,
                  nodeAccessFilter,
                );
              familyWorkflowRequestIds.forEach((requestId) =>
                requestIds.add(requestId),
              );
            }
          }
        }

        if (requestIds.size === 0) {
          const workflow = await prisma.workflow.findFirst({
            where: {
              id: historyLookupId,
              companyId: resolvedCompanyId,
              ...nodeAccessFilter,
            },
            select: { id: true, workflowReqIds: true },
          });

          if (workflow) {
            const familyWorkflowRequestIds =
              await WorkflowDbController.getWorkflowFamilyRequestIds(
                prisma,
                resolvedCompanyId,
                workflow.id,
                nodeAccessFilter,
              );
            familyWorkflowRequestIds.forEach((requestId) =>
              requestIds.add(requestId),
            );
          }
        }

        whereCondition = {
          workflowReqId: { in: Array.from(requestIds) },
        };
      } else if (levelsHash || module || subModule || nodePath) {
        let nodeId: string | undefined;
        if (nodePath) {
          const node = await prisma.orgStructure.findFirst({
            where: { nodePath, companyId: resolvedCompanyId },
          });
          nodeId = node?.id;
        }
        historyIdentityFilter = {
          module: module || undefined,
          subModule: subModule || undefined,
          nodePath: nodePath || undefined,
          nodeId,
          levelsHash: levelsHash || undefined,
        };

        const targetJsonFilters = [
          module
            ? { data: { path: ['target', 'module'], equals: module } }
            : null,
          subModule
            ? { data: { path: ['target', 'subModule'], equals: subModule } }
            : null,
          nodePath
            ? { data: { path: ['target', 'nodePath'], equals: nodePath } }
            : null,
          levelsHash
            ? { data: { path: ['target', 'levelsHash'], equals: levelsHash } }
            : null,
        ].filter(Boolean);
        const requestWhereOptions = [
          {
            companyId: resolvedCompanyId,
            levelsHash: levelsHash || undefined,
            module: module || undefined,
            subModule: subModule || undefined,
            nodeId: nodeId || undefined,
            ...nodeAccessFilter,
          },
          ...(targetJsonFilters.length > 0
            ? [
                {
                  companyId: resolvedCompanyId,
                  AND: targetJsonFilters,
                  ...nodeAccessFilter,
                },
              ]
            : []),
        ];

        const matchingReqs = await prisma.workflowReq.findMany({
          where: { OR: requestWhereOptions as any },
          select: { id: true, workflowId: true, data: true },
        });

        const workflowIdentityFilters: any[] = [];
        const addWorkflowIdentityFilter = (identity: any) => {
          const filter: any = { companyId: resolvedCompanyId };
          if (identity?.module) filter.module = identity.module;
          if (identity?.subModule) filter.subModule = identity.subModule;
          if (identity?.levelsHash) filter.levelsHash = identity.levelsHash;
          if (identity?.nodePath) {
            filter.orgStructure = { nodePath: identity.nodePath };
          } else if (identity?.nodeId) {
            filter.nodeId = identity.nodeId;
          }
          if (!isGlobal) filter.nodeId = { in: userNodeIds };

          if (
            filter.module ||
            filter.subModule ||
            filter.levelsHash ||
            filter.orgStructure ||
            filter.nodeId
          ) {
            workflowIdentityFilters.push(filter);
          }
        };

        addWorkflowIdentityFilter({
          module,
          subModule,
          nodePath,
          nodeId,
          levelsHash,
        });
        matchingReqs.forEach((request) => {
          addWorkflowIdentityFilter((request.data as any)?.target);
        });

        const workflowLookupFilters = [
          ...(matchingReqs.length > 0
            ? [
                {
                  workflowReqIds: {
                    hasSome: matchingReqs.map((request) => request.id),
                  },
                },
              ]
            : []),
          ...workflowIdentityFilters,
        ];

        const matchingWorkflows =
          workflowLookupFilters.length > 0
            ? await prisma.workflow.findMany({
                where: {
                  companyId: resolvedCompanyId,
                  OR: workflowLookupFilters as any,
                },
                select: { id: true, workflowReqIds: true },
              })
            : [];

        const workflowReqIdsFromWorkflows = Array.from(
          new Set(
            matchingWorkflows.flatMap((workflow) =>
              Array.isArray(workflow.workflowReqIds)
                ? workflow.workflowReqIds
                : [],
            ),
          ),
        );

        const reqIdSet = new Set([
          ...matchingReqs.map((request) => request.id),
          ...workflowReqIdsFromWorkflows,
        ]);

        whereCondition = {
          workflowReqId: { in: Array.from(reqIdSet) },
        };
      } else {
        // Default: Fetch all history for the company, but restricted by nodes if not global
        whereCondition = {
          companyId: resolvedCompanyId,
          ...(isGlobal ? {} : { workflowReq: { nodeId: { in: userNodeIds } } }),
        };
      }

      let histories = await prisma.workflowReqHistory.findMany({
        where: whereCondition,
        include: {
          user: {
            include: {
              userAccesses: true,
            },
          },
          workflowReq: true,
          company: { select: { companyCode: true, id: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      const historyWorkflowIds = Array.from(
        new Set(
          histories
            .map((history) => history.workflowReq?.workflowId)
            .filter(Boolean),
        ),
      ) as string[];
      const currentWorkflows =
        historyWorkflowIds.length > 0
          ? await prisma.workflow.findMany({
              where: {
                companyId: resolvedCompanyId,
                id: { in: historyWorkflowIds },
              },
              select: {
                id: true,
                name: true,
                alias: true,
                nodeId: true,
                module: true,
                subModule: true,
                type: true,
                levelsHash: true,
                workflowReqIds: true,
                status: true,
                levels: { orderBy: { level: 'asc' } },
                orgStructure: {
                  select: {
                    nodePath: true,
                  },
                },
              },
            })
          : [];
      const currentWorkflowMap = new Map(
        currentWorkflows.map((workflow) => [workflow.id, workflow]),
      );
      const uniqueRequests = Array.from(
        new Map(
          histories
            .map((history) => history.workflowReq)
            .filter(Boolean)
            .map((request) => [request.id, request]),
        ).values(),
      );
      const requestReplayMap =
        WorkflowDbController.buildWorkflowHistorySnapshotReplayMap(
          uniqueRequests,
          currentWorkflowMap,
        );

      if (historyIdentityFilter) {
        histories = histories.filter((history) =>
          WorkflowDbController.workflowRequestMatchesHistoryIdentity(
            history.workflowReq,
            historyIdentityFilter as WorkflowHistoryIdentityFilter,
            history.workflowReq?.workflowId
              ? currentWorkflowMap.get(history.workflowReq.workflowId)
              : null,
          ),
        );
      }

      // 1. Collect all unique request IDs to fetch their workflow approval status
      const reqIds = Array.from(
        new Set(histories.map((h) => h.workflowReqId).filter(Boolean)),
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
      const subModuleMap = new Map<string, string>();
      const approvedUserMap = new Map<string, Set<string>>();
      histories.forEach((h) => {
        if (h.workflowReqId) {
          if (
            h.workflowReq?.initiatorId &&
            !initiatorMap.has(h.workflowReqId)
          ) {
            initiatorMap.set(h.workflowReqId, h.workflowReq.initiatorId);
          }
          if (h.event === 'INITIATE' && h.eventUserId) {
            initiatorMap.set(h.workflowReqId, h.eventUserId);
          }
          if (h.event === 'APPROVED' && h.eventUserId) {
            const approvedUsers =
              approvedUserMap.get(h.workflowReqId) || new Set<string>();
            approvedUsers.add(h.eventUserId);
            approvedUserMap.set(h.workflowReqId, approvedUsers);
          }
          if (h.workflowReq?.subModule) {
            subModuleMap.set(h.workflowReqId, h.workflowReq.subModule);
          }
        }
      });
      // console.log(`[WorkflowHistory] Built initiatorMap with ${initiatorMap.size} entries`);

      // Filter each stored approver list for active display only. The DB row is not mutated.
      for (const [reqId, levels] of workflowMap.entries()) {
        const initiatorId = initiatorMap.get(reqId) || null;
        const subModule = subModuleMap.get(reqId) || 'WORK_FLOW';
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
              subModule,
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
        userId,
        ...Array.from(allApproverIds),
        ...histories.map((h) => h.eventUserId),
      ]);
      const approverMap = new Map(
        approverDetails.map((u) => [
          u.id,
          HistoryUserUtil.formatAuditUser(u, u.id, saasAdminUserIds, userId),
        ]),
      );

      const resultList: any[] = [];
      const handledPendingReqs = new Set<string>();
      const modificationSequenceByReqId = new Map<string, number>();
      histories
        .filter((history) => history.workflowReqId)
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
          const requestType =
            WorkflowDbController.resolveWorkflowHistoryRequestType(
              history.workflowReq,
            );
          if (
            history.event === 'INITIATE' &&
            WorkflowDbController.isWorkflowModificationHistoryType(
              requestType,
            ) &&
            history.workflowReqId &&
            !modificationSequenceByReqId.has(history.workflowReqId)
          ) {
            modificationSequenceByReqId.set(
              history.workflowReqId,
              modificationSequenceByReqId.size + 1,
            );
          }
        });

      // 3. Inject "Pending Approval" entries for any active requests
      histories.forEach((h) => {
        if (h.workflowReqId && !handledPendingReqs.has(h.workflowReqId)) {
          const levels = workflowMap.get(h.workflowReqId);
          if (levels) {
            const currentPending = levels.find((l) => l.status === 'PENDING');
            if (currentPending) {
              const snapshots = h.workflowReqId
                ? requestReplayMap.get(h.workflowReqId) || {
                    oldData: null,
                    newData: null,
                  }
                : {
                    oldData: null,
                    newData: null,
                  };
              const requestChangeCount = snapshots.newData
                ? WorkflowDbController.getWorkflowHistoryChangeCountFromSnapshots(
                    snapshots.oldData,
                    snapshots.newData,
                    h.workflowReq?.type,
                  )
                : WorkflowDbController.getWorkflowHistoryChangeCount(
                    h.workflowReq?.data,
                    h.workflowReq?.oldData,
                    h.workflowReq?.type,
                  );
              const approvers = (currentPending.approversList as string[])
                .map((id) => {
                  const u = approverMap.get(id);
                  return u ? { name: u.name, email: u.email } : null;
                })
                .filter(Boolean);

              const newDataObj =
                WorkflowDbController.sanitizeWorkflowHistoryData(
                  h.workflowReq?.data,
                  h.workflowReq?.type,
                );

              resultList.push({
                id: `${h.workflowReqId}`,
                workflowReqId: h.workflowReqId,
                workflowId: h.workflowReq?.workflowId || null,
                type: h.workflowReq?.type || null,
                impact: h.workflowReq?.impact || null,
                oldData:
                  h.workflowReq?.oldData ||
                  ((h.workflowReq?.data as any)?.oldData ?? null),
                newData: newDataObj,
                nodeId: h.workflowReq?.nodeId || null,
                workflowName: h.workflowReq
                  ? WorkflowDbController.getWorkflowRequestDisplayName(
                      h.workflowReq,
                    )
                  : null,
                module: h.workflowReq?.module || null,
                subModule: h.workflowReq?.subModule || null,
                levelsHash: h.workflowReq?.levelsHash || null,
                alias: h.workflowReq?.alias || null,
                nodePath: (h.workflowReq?.data as any)?.nodePath || null,
                nodeName: (h.workflowReq?.data as any)?.nodeName || null,
                nodeType: (h.workflowReq?.data as any)?.nodeType || null,
                companyCode: h.company.companyCode,
                changeCount: requestChangeCount,
                levelCount: `A${currentPending.level}`,
                event: `L${currentPending.level} Pending Approval`,
                createdAt: null,
                eligibleapprovers: approvers,
              });
            }
          }
          handledPendingReqs.add(h.workflowReqId);
        }
      });

      // 4. Format the output for the UI
      const formattedHistories = histories.map((h) => {
        const requestType =
          WorkflowDbController.resolveWorkflowHistoryRequestType(h.workflowReq);
        const isAutoHistory = WorkflowDbController.isWorkflowAutoHistoryType(
          requestType,
          h.event,
        );
        const isChangeRequestStart =
          h.event === 'INITIATE' &&
          WorkflowDbController.isWorkflowModificationHistoryType(requestType);
        const displayEvent =
          WorkflowDbController.getWorkflowHistoryDisplayEvent(
            h.event,
            requestType,
          );
        const levelCount =
          isChangeRequestStart && h.workflowReqId
            ? `M${modificationSequenceByReqId.get(h.workflowReqId) || 1}`
            : displayEvent === 'INITIATE'
              ? 'I'
              : displayEvent === 'APPROVED' && h.level
                ? `A${h.level}`
                : null;
        const snapshots = h.workflowReqId
          ? requestReplayMap.get(h.workflowReqId) || {
              oldData: null,
              newData: null,
            }
          : {
              oldData: null,
              newData: null,
            };
        const newDataObj = isAutoHistory
          ? null
          : WorkflowDbController.sanitizeWorkflowHistoryData(
              h.workflowReq?.data,
              h.workflowReq?.type,
            );
        const linkedParentWorkflow =
          WorkflowDbController.buildWorkflowHistoryLinkedWorkflow(h);
        const changeCount = isAutoHistory
          ? {
              added: 0,
              modify: 0,
              remove: 0,
            }
          : snapshots.newData
            ? WorkflowDbController.getWorkflowHistoryChangeCountFromSnapshots(
                snapshots.oldData,
                snapshots.newData,
                h.workflowReq?.type,
              )
            : WorkflowDbController.getWorkflowHistoryChangeCount(
                h.workflowReq?.data,
                h.workflowReq?.oldData,
                h.workflowReq?.type,
              );

        return {
          id: h.id,
          workflowReqId: h.workflowReqId,
          workflowId: h.workflowReq?.workflowId || null,
          type: h.workflowReq?.type || null,
          impact: h.workflowReq?.impact || null,
          oldData: isAutoHistory
            ? null
            : h.workflowReq?.oldData ||
              ((h.workflowReq?.data as any)?.oldData ?? null),
          newData: newDataObj,
          nodeId: h.workflowReq?.nodeId || null,
          workflowName: h.workflowReq
            ? WorkflowDbController.getWorkflowRequestDisplayName(h.workflowReq)
            : null,
          module: h.workflowReq?.module || null,
          subModule: h.workflowReq?.subModule || null,
          levelsHash: h.workflowReq?.levelsHash || null,
          alias: h.workflowReq?.alias || null,
          nodePath: (h.workflowReq?.data as any)?.nodePath || null,
          nodeName: (h.workflowReq?.data as any)?.nodeName || null,
          nodeType: (h.workflowReq?.data as any)?.nodeType || null,
          companyCode: h.company.companyCode,
          event: displayEvent,
          levelCount,
          level: h.level,
          createdAt: h.createdAt,
          remarks: WorkflowDbController.formatWorkflowHistoryRemarks(h),
          changeCount,
          linkedWorkflow: linkedParentWorkflow,
          user: HistoryUserUtil.formatAuditUser(
            h.user,
            h.eventUserId,
            saasAdminUserIds,
            userId,
          ),
        };
      });

      resultList.push(...formattedHistories);
      resultList.sort((left, right) => {
        const leftTime = left.createdAt
          ? new Date(left.createdAt).getTime()
          : Number.MAX_SAFE_INTEGER;
        const rightTime = right.createdAt
          ? new Date(right.createdAt).getTime()
          : Number.MAX_SAFE_INTEGER;
        if (leftTime !== rightTime) return rightTime - leftTime;
        return String(left.id).localeCompare(String(right.id));
      });

      res.status(200).json({
        message: 'Workflow history fetched successfully!',
        code: 200,
        data: resultList,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Fetches a single workflow history event with its resolved request snapshot.
   */
  static async getWorkflowHistoryDetail(
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
      if (!resolvedCompanyId && companyCode) {
        const company = await prisma.company.findUnique({
          where: { companyCode },
          select: { id: true },
        });
        if (!company) throw new AppError('Company not found', 404);
        resolvedCompanyId = company.id;
      }

      if (!resolvedCompanyId) {
        throw new AppError('companyCode or companyId is required', 400);
      }

      const historyLookupId = WorkflowDbController.normalizeHistoryLookupId(id);
      const approverLookup = await prisma.workflowApprover.findFirst({
        where: {
          id: historyLookupId as string,
          reqTable: 'workflow_req',
        },
        select: { reqId: true, level: true },
      });
      const requestLookupId = approverLookup?.reqId || historyLookupId;
      const historyInclude = {
        user: {
          include: {
            userAccesses: true,
          },
        },
        workflowReq: true,
        company: { select: { companyCode: true, id: true } },
      } as const;
      let history: any = await prisma.workflowReqHistory.findFirst({
        where: {
          id: historyLookupId as string,
          companyId: resolvedCompanyId,
        },
        include: historyInclude,
      });
      if (!history) {
        history = await prisma.workflowReqHistory.findFirst({
          where: {
            workflowReqId: requestLookupId as string,
            companyId: resolvedCompanyId,
            event: 'INITIATE',
          },
          orderBy: { createdAt: 'asc' },
          include: historyInclude,
        });
      }
      if (!history) {
        history = await prisma.workflowReqHistory.findFirst({
          where: {
            workflowReqId: requestLookupId as string,
            companyId: resolvedCompanyId,
          },
          orderBy: { createdAt: 'asc' },
          include: historyInclude,
        });
      }

      if (!history) {
        const workflowReq = await prisma.workflowReq.findFirst({
          where: {
            id: requestLookupId as string,
            companyId: resolvedCompanyId,
          },
          include: {
            company: { select: { companyCode: true, id: true } },
          },
        });

        if (!workflowReq) {
          throw new AppError('Workflow history not found', 404);
        }

        const eventUserId = workflowReq.initiatorId || viewerUserId || '';
        const eventUser = eventUserId
          ? await prisma.user.findUnique({
              where: { id: eventUserId },
              include: {
                userAccesses: true,
              },
            })
          : null;

        history = {
          id: workflowReq.id,
          workflowReqId: workflowReq.id,
          companyId: workflowReq.companyId,
          level: approverLookup?.level || null,
          event: 'INITIATE',
          eventUserId,
          createdAt: workflowReq.createdAt,
          remarks: workflowReq.approvalRemark,
          workflowReq,
          company: workflowReq.company,
          user: eventUser,
        } as any;
      }

      const requestData = (history.workflowReq?.data as any) || null;
      const requestType =
        WorkflowDbController.resolveWorkflowHistoryRequestType(
          history.workflowReq,
        );
      const isAutoHistory = WorkflowDbController.isWorkflowAutoHistoryType(
        requestType,
        history.event,
      );
      const displayEvent = WorkflowDbController.getWorkflowHistoryDisplayEvent(
        history.event,
        requestType,
      );
      const targetNodePath =
        (requestData?.target?.nodePath as string | undefined) ||
        requestData?.nodePath ||
        null;
      const targetNode = targetNodePath
        ? await prisma.orgStructure.findFirst({
            where: {
              companyId: resolvedCompanyId,
              nodePath: targetNodePath,
              status: 'ACTIVE',
            },
            select: { id: true },
          })
        : null;
      const targetInfo =
        WorkflowDbController.extractWorkflowTarget(requestData) ||
        WorkflowDbController.extractWorkflowTarget({
          target: {
            module: history.workflowReq?.module,
            subModule: history.workflowReq?.subModule,
            nodePath: targetNodePath,
            levelsHash: history.workflowReq?.levelsHash,
          },
        });
      const targetWorkflow = targetInfo
        ? await prisma.workflow.findFirst({
            where: {
              companyId: resolvedCompanyId,
              ...(targetNode?.id ? { nodeId: targetNode.id } : {}),
              module: targetInfo.module,
              subModule: targetInfo.subModule,
              levelsHash: targetInfo.levelsHash,
              ...(!targetNode?.id
                ? { orgStructure: { nodePath: targetInfo.nodePath } }
                : {}),
            } as any,
            include: {
              levels: { orderBy: { level: 'asc' } },
              orgStructure: {
                select: {
                  nodePath: true,
                  nodeName: true,
                  nodeType: true,
                },
              },
            },
          })
        : null;
      const linkedWorkflow = history.workflowReqId
        ? await prisma.workflow.findFirst({
            where: {
              companyId: resolvedCompanyId,
              workflowReqIds: { has: history.workflowReqId },
            },
            include: {
              levels: { orderBy: { level: 'asc' } },
              orgStructure: {
                select: {
                  nodePath: true,
                  nodeName: true,
                  nodeType: true,
                },
              },
            },
          })
        : null;
      const directWorkflow =
        history.workflowReq?.workflowId && requestType !== 'INITIATE'
          ? await prisma.workflow.findFirst({
              where: {
                id: history.workflowReq.workflowId,
                companyId: resolvedCompanyId,
              },
              include: {
                levels: { orderBy: { level: 'asc' } },
                orgStructure: {
                  select: {
                    nodePath: true,
                    nodeName: true,
                    nodeType: true,
                  },
                },
              },
            })
          : null;
      const relatedWorkflow =
        targetWorkflow || linkedWorkflow || directWorkflow;
      const pendingSnapshots =
        requestType !== 'INITIATE' && history.workflowReq?.status === 'PENDING'
          ? WorkflowDbController.buildPendingWorkflowHistorySnapshots(
              history.workflowReq,
              directWorkflow || targetWorkflow || linkedWorkflow,
            )
          : null;
      const selectedRequestFallback =
        WorkflowDbController.buildWorkflowRequestSnapshotFallback(
          history.workflowReq,
          relatedWorkflow,
        );
      const relatedWorkflowReqIds = new Set<string>(
        Array.isArray(relatedWorkflow?.workflowReqIds)
          ? relatedWorkflow.workflowReqIds
          : [],
      );
      const allRequests = await prisma.workflowReq.findMany({
        where:
          relatedWorkflow && relatedWorkflowReqIds.size > 0
            ? {
                companyId: resolvedCompanyId,
                OR: [
                  { id: history.workflowReqId },
                  { id: { in: Array.from(relatedWorkflowReqIds) } },
                  { workflowId: relatedWorkflow.id },
                ],
              }
            : { companyId: resolvedCompanyId },
        select: {
          id: true,
          workflowId: true,
          data: true,
          oldData: true,
          alias: true,
          type: true,
          status: true,
          createdAt: true,
          module: true,
          subModule: true,
          levelsHash: true,
          nodeId: true,
        },
      });
      const historyRequests = allRequests
        .filter((request) => {
          if (relatedWorkflow) {
            return (
              request.id === history.workflowReqId ||
              request.workflowId === relatedWorkflow.id ||
              relatedWorkflowReqIds.has(request.id)
            );
          }

          const requestTarget =
            WorkflowDbController.extractWorkflowTarget(request.data) ||
            WorkflowDbController.extractWorkflowTarget({
              target: {
                module: request.module,
                subModule: request.subModule,
                nodePath:
                  (request.data as any)?.target?.nodePath ||
                  (request.data as any)?.nodePath ||
                  null,
                levelsHash: request.levelsHash,
              },
            });

          return (
            requestTarget &&
            targetInfo &&
            requestTarget.module === targetInfo.module &&
            requestTarget.subModule === targetInfo.subModule &&
            requestTarget.nodePath === targetInfo.nodePath &&
            requestTarget.levelsHash === targetInfo.levelsHash &&
            (request.status !== 'REJECTED' ||
              request.id === history.workflowReqId)
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

      if (pendingSnapshots) {
        oldData = pendingSnapshots.oldData;
        newData = pendingSnapshots.newData;
      } else {
        for (const request of historyRequests) {
          const nextSnapshot: Record<string, unknown> | null =
            request.type === 'INITIATE'
              ? WorkflowDbController.extractWorkflowSnapshot(
                  request.data,
                  WorkflowDbController.buildWorkflowRequestSnapshotFallback(
                    request,
                  ),
                )
              : currentSnapshot
                ? WorkflowDbController.applyWorkflowRequestSnapshot(
                    currentSnapshot,
                    request,
                  )
                : WorkflowDbController.extractWorkflowSnapshot(
                    request.data,
                    WorkflowDbController.buildWorkflowRequestSnapshotFallback(
                      request,
                    ),
                  );

          if (!nextSnapshot) continue;

          if (request.id === history.workflowReqId) {
            oldData = currentSnapshot
              ? cloneJson(currentSnapshot)
              : WorkflowDbController.buildWorkflowOldSnapshotFromPatch(
                  request.data,
                  request.oldData,
                  WorkflowDbController.buildWorkflowRequestSnapshotFallback(
                    request,
                  ),
                );
            newData = nextSnapshot;
            break;
          }

          currentSnapshot = nextSnapshot;
        }
      }

      if (!newData && oldData && requestType !== 'INITIATE') {
        newData =
          WorkflowDbController.applyWorkflowRequestSnapshot(
            oldData,
            history.workflowReq,
          ) || null;
      }
      if (!newData) {
        newData = WorkflowDbController.extractWorkflowSnapshot(
          requestData,
          selectedRequestFallback,
        );
      }
      if (!oldData && requestType !== 'INITIATE') {
        oldData = WorkflowDbController.buildWorkflowOldSnapshotFromPatch(
          requestData,
          history.workflowReq?.oldData,
          selectedRequestFallback,
        );
      }
      if (oldData && requestType !== 'INITIATE') {
        oldData = WorkflowDbController.repairWorkflowSnapshotWithFallback(
          oldData,
          selectedRequestFallback,
          history.workflowReq?.oldData,
        );
      }
      if (
        !pendingSnapshots &&
        requestType !== 'INITIATE' &&
        history.workflowReq?.status === 'PENDING' &&
        relatedWorkflow
      ) {
        const currentTargetSnapshot =
          WorkflowDbController.extractWorkflowSnapshot(
            selectedRequestFallback,
            selectedRequestFallback,
          );
        if (currentTargetSnapshot) {
          oldData = currentTargetSnapshot;
          newData =
            WorkflowDbController.applyWorkflowRequestSnapshot(
              currentTargetSnapshot,
              history.workflowReq,
            ) || newData;
        }
      }

      if (isAutoHistory) {
        oldData = null;
        newData = null;
      }

      const changeCount = isAutoHistory
        ? {
            added: 0,
            modify: 0,
            remove: 0,
          }
        : oldData && newData
          ? WorkflowDbController.getWorkflowHistoryChangeCountFromSnapshots(
              oldData,
              newData,
              requestType,
            )
          : WorkflowDbController.getWorkflowHistoryChangeCount(
              requestData,
              oldData,
              requestType,
            );
      const detailData = isAutoHistory
        ? {
            oldData: null,
            newData: null,
          }
        : WorkflowDbController.buildWorkflowHistoryDetailDiff(
            oldData,
            newData,
            requestType,
          );
      const linkedParentWorkflow =
        WorkflowDbController.buildWorkflowHistoryLinkedWorkflow(history);

      const saasAdminUserIds = await HistoryUserUtil.getSaasAdminUserIds([
        viewerUserId,
        history.eventUserId,
      ]);

      res.status(200).json({
        message: 'Workflow history item fetched successfully!',
        code: 200,
        data: {
          id: history.id,
          workflowReqId: history.workflowReqId,
          workflowId: history.workflowReq?.workflowId || null,
          companyCode: history.company.companyCode,
          type: history.workflowReq?.type || null,
          impact: history.workflowReq?.impact || null,
          event: displayEvent,
          rawEvent: history.event,
          level: history.level,
          createdAt: history.createdAt,
          remarks: WorkflowDbController.formatWorkflowHistoryRemarks(history),
          changeCount,
          oldData: detailData.oldData,
          newData: detailData.newData,
          user: HistoryUserUtil.formatAuditUser(
            history.user,
            history.eventUserId,
            saasAdminUserIds,
            viewerUserId,
          ),
          request: history.workflowReq
            ? {
                id: history.workflowReq.id,
                type: history.workflowReq.type,
                status: history.workflowReq.status,
                workflowId: history.workflowReq.workflowId,
                approvalRemark: history.workflowReq.approvalRemark,
                levelsHash: history.workflowReq.levelsHash,
                alias: history.workflowReq.alias,
                createdAt: history.workflowReq.createdAt,
                module: history.workflowReq.module,
                subModule: history.workflowReq.subModule,
                nodeId: history.workflowReq.nodeId,
              }
            : null,
          workflowName: history.workflowReq
            ? WorkflowDbController.getWorkflowRequestDisplayName(
                history.workflowReq,
              )
            : null,
          module: history.workflowReq?.module || null,
          subModule: history.workflowReq?.subModule || null,
          levelsHash: history.workflowReq?.levelsHash || null,
          alias: history.workflowReq?.alias || null,
          nodePath: requestData?.nodePath || null,
          nodeName: requestData?.nodeName || null,
          nodeType: requestData?.nodeType || null,
          linkedWorkflow: linkedParentWorkflow,
        },
      });
    } catch (error) {
      next(error);
    }
  }
  /**
   * Fetches one cursor-paginated active or pending workflow list.
   */
  static async fetchWorkflows(req: Request, res: Response, next: NextFunction) {
    try {
      const { companyCode, companyId, userId } = req.body;
      const type =
        req.body?.type === 'pending'
          ? 'pending'
          : req.body?.type === 'inactive'
            ? 'inactive'
            : req.body?.type === 'archive'
              ? 'archive'
              : 'active';
      const query =
        typeof req.body?.query === 'string' && req.body.query.trim()
          ? req.body.query.trim()
          : null;
      const pagination = resolveCursorPagination(req.body ?? {});

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

      // Check if requester is a global access user
      let isGlobal = true;
      let userNodeIds: string[] = [];

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
          const accesses = await prisma.userAccess.findMany({
            where: { userId, companyId: resolvedCompanyId },
            select: { nodeId: true },
          });
          userNodeIds = accesses.map((a) => a.nodeId);
        }
      }

      const buildWorkflowStatusWhere = (
        status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVE',
      ) => ({
        companyId: resolvedCompanyId,
        status,
        AND: [
          { orgStructure: { is: { status: 'ACTIVE' } } },
          ...(isGlobal
            ? []
            : [
                {
                  OR: [
                    { nodeId: { in: userNodeIds } },
                    { name: { contains: 'DEFAULT' } },
                  ],
                },
              ]),
          ...(query
            ? [
                {
                  OR: [
                    { name: { contains: query, mode: 'insensitive' } },
                    { alias: { contains: query, mode: 'insensitive' } },
                    { module: { contains: query, mode: 'insensitive' } },
                    { subModule: { contains: query, mode: 'insensitive' } },
                    {
                      orgStructure: {
                        is: {
                          nodeName: { contains: query, mode: 'insensitive' },
                        },
                      },
                    },
                    {
                      orgStructure: {
                        is: {
                          nodePath: { contains: query, mode: 'insensitive' },
                        },
                      },
                    },
                  ],
                },
              ]
            : []),
        ],
      });
      const activeBaseWhere: any = buildWorkflowStatusWhere('ACTIVE');
      const pendingWhere: any = {
        companyId: resolvedCompanyId,
        status: 'PENDING',
      };
      const inactiveBaseWhere: any = buildWorkflowStatusWhere('INACTIVE');
      const archiveBaseWhere: any = buildWorkflowStatusWhere('ARCHIVE');
      const autoGeneratedParentByWorkflowId =
        await WorkflowDbController.getAutoGeneratedParentMap(
          prisma,
          resolvedCompanyId,
        );
      const autoGeneratedWorkflowIds = Array.from(
        autoGeneratedParentByWorkflowId.keys(),
      );
      const activeWhere =
        autoGeneratedWorkflowIds.length > 0
          ? {
              ...activeBaseWhere,
              NOT: { id: { in: autoGeneratedWorkflowIds } },
            }
          : activeBaseWhere;
      const inactiveWhere =
        autoGeneratedWorkflowIds.length > 0
          ? {
              ...inactiveBaseWhere,
              NOT: { id: { in: autoGeneratedWorkflowIds } },
            }
          : inactiveBaseWhere;
      const archiveWhere =
        autoGeneratedWorkflowIds.length > 0
          ? {
              ...archiveBaseWhere,
              NOT: { id: { in: autoGeneratedWorkflowIds } },
            }
          : archiveBaseWhere;
      const visiblePendingRequestIds =
        await WorkflowDbController.getCurrentViewerRequestIds(
          userId,
          resolvedCompanyId,
        );
      const pendingListWhere: any = {
        ...pendingWhere,
        id: { in: visiblePendingRequestIds },
      };
      const listWhere =
        type === 'pending'
          ? pendingListWhere
          : type === 'inactive'
            ? inactiveWhere
            : type === 'archive'
              ? archiveWhere
              : activeWhere;
      const pageWhere = pagination.cursor
        ? appendCursorWhere(
            listWhere,
            pagination.cursor,
            pagination.direction === 'prev' ? 'newer' : 'older',
          )
        : listWhere;
      const newWhere = pagination.topCursor
        ? appendCursorWhere(listWhere, pagination.topCursor, 'newer')
        : null;
      const activeSelect = {
        id: true,
        createdAt: true,
        name: true,
        alias: true,
        type: true,
        status: true,
        module: true,
        subModule: true,
        orgStructure: {
          select: {
            nodePath: true,
            nodeName: true,
            nodeType: true,
          },
        },
        levelsHash: true,
        levels: {
          select: {
            level: true,
            approver1: true,
            approver2: true,
            approverType: true,
          },
        },
      } as const;
      const pendingSelect = {
        id: true,
        nodeId: true,
        workflowId: true,
        approvalWorkflowId: true,
        data: true,
        oldData: true,
        type: true,
        status: true,
        alias: true,
        impact: true,
        approvalRemark: true,
        levelsHash: true,
        createdAt: true,
        workflowHistories: {
          where: { event: 'INITIATE' as const },
          select: {
            createdAt: true,
            user: { select: { name: true, email: true } },
          },
        },
      } as const;
      const normalizedQuery = query?.toLowerCase() || null;
      const filteredPendingRows = normalizedQuery
        ? await (async () => {
            const requests = await prisma.workflowReq.findMany({
              where: pendingListWhere,
              select: pendingSelect,
            });
            const nodeIds = Array.from(
              new Set(
                requests.map((request) => request.nodeId).filter(Boolean),
              ),
            ) as string[];
            const nodes =
              nodeIds.length > 0
                ? await prisma.orgStructure.findMany({
                    where: { id: { in: nodeIds } },
                    select: { id: true, nodeName: true, nodePath: true },
                  })
                : [];
            const nodeMap = new Map(nodes.map((node) => [node.id, node]));
            return requests.filter((request) => {
              const data = request.data as any;
              const target = data?.target || {};
              const node = nodeMap.get(request.nodeId);
              return [
                data?.name,
                request.alias,
                data?.module,
                data?.subModule,
                target?.module,
                target?.subModule,
                target?.nodePath,
                data?.nodePath,
                node?.nodeName,
                node?.nodePath,
              ].some(
                (value) =>
                  typeof value === 'string' &&
                  value.toLowerCase().includes(normalizedQuery),
              );
            });
          })()
        : null;
      const [
        activeCount,
        pendingCount,
        inactiveCount,
        archiveCount,
        selectedRows,
        newCount,
      ] = await Promise.all([
        prisma.workflow.count({ where: activeWhere }),
        filteredPendingRows
          ? (async () => {
              const effectiveIds =
                await WorkflowDbController.filterEffectivelyPendingRequestIds(
                  'workflow_req',
                  filteredPendingRows.map((row: any) => row.id),
                );
              return filteredPendingRows.filter((row: any) =>
                effectiveIds.has(row.id),
              ).length;
            })()
          : prisma.workflowReq.count({ where: pendingListWhere }),
        prisma.workflow.count({ where: inactiveWhere }),
        prisma.workflow.count({ where: archiveWhere }),
        type === 'active' || type === 'inactive' || type === 'archive'
          ? prisma.workflow.findMany({
              where: pageWhere,
              select: activeSelect,
              orderBy: getPageOrder(pagination.direction) as any,
              skip: pagination.cursor ? 0 : pagination.offset,
              take: pagination.limit + 1,
            })
          : filteredPendingRows
            ? Promise.resolve(
                getInMemoryPageRows(filteredPendingRows, pagination),
              )
            : prisma.workflowReq.findMany({
                where: pageWhere,
                select: pendingSelect,
                orderBy: getPageOrder(pagination.direction) as any,
                skip: pagination.cursor ? 0 : pagination.offset,
                take: pagination.limit + 1,
              }),
        newWhere
          ? type === 'active' || type === 'inactive' || type === 'archive'
            ? prisma.workflow.count({ where: newWhere })
            : filteredPendingRows && pagination.topCursor
              ? Promise.resolve(
                  filteredPendingRows.filter((request) =>
                    isRowInCursorDirection(
                      request,
                      pagination.topCursor!,
                      'newer',
                    ),
                  ).length,
                )
              : prisma.workflowReq.count({ where: newWhere })
          : Promise.resolve(0),
      ]);
      const pageData = buildPage(selectedRows as any[], pagination, newCount);
      const firstPageRow = pageData.pageRows[0];
      if (pagination.cursor && !pagination.isPagePagination && firstPageRow) {
        const newerWhere = appendCursorWhere(listWhere, firstPageRow, 'newer');
        const newerCount =
          type === 'active' || type === 'inactive' || type === 'archive'
            ? await prisma.workflow.count({ where: newerWhere })
            : filteredPendingRows
              ? filteredPendingRows.filter((request) =>
                  isRowInCursorDirection(request, firstPageRow, 'newer'),
                ).length
              : await prisma.workflowReq.count({ where: newerWhere });
        pageData.pageInfo.page = Math.floor(newerCount / pagination.limit) + 1;
      }

      if (type === 'active' || type === 'inactive' || type === 'archive') {
        const activeRows = pageData.pageRows as any[];
        const autoDeletedWorkflowIds =
          type === 'active'
            ? await WorkflowDbController.getAutoDeletedWorkflowIds(
                prisma,
                resolvedCompanyId,
              )
            : new Set<string>();
        const visibleWorkflowRows =
          type === 'active'
            ? [
                ...(await prisma.workflow.findMany({
                  where: activeBaseWhere,
                  select: activeSelect,
                })),
                ...(await prisma.workflow.findMany({
                  where: archiveBaseWhere,
                  select: activeSelect,
                })),
              ]
            : await prisma.workflow.findMany({
                where:
                  type === 'inactive' ? inactiveBaseWhere : archiveBaseWhere,
                select: activeSelect,
              });
        const visibleWorkflowIds = new Set(
          visibleWorkflowRows.map((row) => row.id),
        );
        const visibleWorkflowByIdentity = new Map<string, string>();
        visibleWorkflowRows.forEach((row) => {
          const nodePath = row.orgStructure?.nodePath || null;
          if (!nodePath) return;
          visibleWorkflowByIdentity.set(
            [row.module, row.subModule, nodePath, row.levelsHash].join('|'),
            row.id,
          );
        });
        const pendingWorkflowRequests =
          visibleWorkflowRows.length > 0
            ? await prisma.workflowReq.findMany({
                where: {
                  companyId: resolvedCompanyId,
                  status: 'PENDING',
                  type: { in: ['UPDATE', 'INACTIVE', 'ARCHIVE'] },
                },
                select: {
                  id: true,
                  workflowId: true,
                  type: true,
                  module: true,
                  subModule: true,
                  levelsHash: true,
                  data: true,
                },
              })
            : [];
        const effectivePendingWorkflowRequestIds =
          await WorkflowDbController.filterEffectivelyPendingRequestIds(
            'workflow_req',
            pendingWorkflowRequests.map((request) => request.id),
          );
        const pendingWorkflowIds = new Set(
          pendingWorkflowRequests
            .filter((request) =>
              effectivePendingWorkflowRequestIds.has(request.id),
            )
            .flatMap((request) => {
              const explicitRequestTarget =
                WorkflowDbController.extractWorkflowTarget(request.data);
              const requestTarget = explicitRequestTarget || {
                module: request.module,
                subModule: request.subModule,
                nodePath:
                  (request.data as any)?.nodePath ||
                  (request.data as any)?.target?.nodePath ||
                  null,
                levelsHash: request.levelsHash,
              };
              if (
                !requestTarget?.module ||
                !requestTarget?.subModule ||
                !requestTarget?.nodePath ||
                !requestTarget?.levelsHash
              ) {
                return [];
              }

              const requestIdentity = [
                requestTarget.module,
                requestTarget.subModule,
                requestTarget.nodePath,
                requestTarget.levelsHash,
              ].join('|');
              const workflowId = visibleWorkflowByIdentity.get(requestIdentity);
              if (workflowId) {
                return [workflowId];
              }

              if (explicitRequestTarget) {
                return [];
              }

              if (
                request.workflowId &&
                visibleWorkflowIds.has(request.workflowId)
              ) {
                return [request.workflowId];
              }

              return [];
            })
            .filter((workflowId): workflowId is string => !!workflowId),
        );
        const activeRowsWithPending = WorkflowDbController.buildWorkflowTree(
          activeRows,
          visibleWorkflowRows,
          autoGeneratedParentByWorkflowId,
          pendingWorkflowIds,
          autoDeletedWorkflowIds,
        );

        return res.status(200).json({
          data: activeRowsWithPending,
          activeCount,
          pendingCount,
          inactiveCount,
          archiveCount,
          pageInfo: pageData.pageInfo,
        });
      }

      const pendingRequestsRawUnfiltered = pageData.pageRows as any[];
      const effectivePendingIds =
        await WorkflowDbController.filterEffectivelyPendingRequestIds(
          'workflow_req',
          pendingRequestsRawUnfiltered.map((row) => row.id),
        );
      const pendingRequestsRaw = pendingRequestsRawUnfiltered.filter((row) =>
        effectivePendingIds.has(row.id),
      );
      const workflowIds = Array.from(
        new Set(
          pendingRequestsRaw
            .flatMap((req) => [req.workflowId, req.approvalWorkflowId])
            .filter(Boolean),
        ),
      ) as string[];
      const targetTuples = Array.from(
        new Set(
          pendingRequestsRaw
            .map((req) => (req.data as any)?.target)
            .filter(
              (target: any) =>
                target &&
                typeof target.module === 'string' &&
                typeof target.subModule === 'string' &&
                typeof target.nodePath === 'string' &&
                typeof target.levelsHash === 'string',
            )
            .map(
              (target: any) =>
                `${target.module}|${target.subModule}|${target.nodePath}|${target.levelsHash}`,
            ),
        ),
      );
      const targetFilters = targetTuples.map((tuple) => {
        const [module, subModule, nodePath, levelsHash] = tuple.split('|');
        return {
          module,
          subModule,
          levelsHash,
          orgStructure: { nodePath },
        };
      });

      const nodeIds = Array.from(
        new Set(pendingRequestsRaw.map((req) => req.nodeId)),
      ) as string[];

      const [workflowDetails, targetWorkflowDetails, nodeDetails, allOrgNodes] =
        await Promise.all([
          prisma.workflow.findMany({
            where: { id: { in: workflowIds } },
            select: {
              id: true,
              name: true,
              alias: true,
              type: true,
              module: true,
              subModule: true,
              levelsHash: true,
              status: true,
              orgStructure: {
                select: {
                  nodePath: true,
                  nodeName: true,
                  nodeType: true,
                },
              },
              levels: {
                select: {
                  level: true,
                  approver1: true,
                  approver2: true,
                  approverType: true,
                },
              },
            },
          }),
          targetFilters.length > 0
            ? prisma.workflow.findMany({
                where: {
                  companyId: resolvedCompanyId,
                  OR: targetFilters as any,
                },
                select: {
                  id: true,
                  name: true,
                  alias: true,
                  type: true,
                  module: true,
                  subModule: true,
                  levelsHash: true,
                  status: true,
                  orgStructure: {
                    select: {
                      nodePath: true,
                      nodeName: true,
                      nodeType: true,
                    },
                  },
                  levels: {
                    select: {
                      level: true,
                      approver1: true,
                      approver2: true,
                      approverType: true,
                    },
                  },
                },
              })
            : Promise.resolve([]),
          prisma.orgStructure.findMany({
            where: { id: { in: nodeIds } },
            select: {
              id: true,
              nodeName: true,
              nodePath: true,
              nodeType: true,
            },
          }),
          prisma.orgStructure.findMany({
            where: {
              companyId: resolvedCompanyId,
              status: 'ACTIVE',
            },
            select: {
              nodePath: true,
              nodeName: true,
              nodeType: true,
            },
          }),
        ]);

      const workflowMap = new Map(workflowDetails.map((w) => [w.id, w]));
      const targetWorkflowMap = new Map(
        targetWorkflowDetails.map((w) => [
          [w.module, w.subModule, w.orgStructure?.nodePath, w.levelsHash].join(
            '|',
          ),
          w,
        ]),
      );
      const nodeMap = new Map(nodeDetails.map((n) => [n.id, n]));

      // 2. Flatten initiator, node info, and workflow info for frontend
      const pendingRequests = pendingRequestsRaw.map((req) => {
        const historyEntry = req.workflowHistories[0];
        const initiator = historyEntry?.user || {
          name: '',
          email: '',
        };
        const initiatorTimestamp = historyEntry?.createdAt || req.createdAt;
        const node = nodeMap.get(req.nodeId);
        const nodeType = node?.nodeType || null;
        const linkedOrgStructure = WorkflowDbController.buildLinkedOrgStructure(
          allOrgNodes,
          node?.nodePath || (req.data as any)?.nodePath || null,
        );

        // Resolve workflow name, alias, and master data (target match first)
        const target = (req.data as any)?.target;
        const targetKey = [
          target?.module,
          target?.subModule,
          target?.nodePath,
          target?.levelsHash,
        ].join('|');
        const targetWorkflow = targetWorkflowMap.get(targetKey);
        const linkedWorkflow = req.workflowId
          ? workflowMap.get(req.workflowId)
          : null;
        const approvalWorkflow = req.approvalWorkflowId
          ? workflowMap.get(req.approvalWorkflowId)
          : null;
        const associatedWorkflow = targetWorkflow || linkedWorkflow || null;
        const requestData = (req.data as any) || {};
        const fallbackAlias = requestData?.levels
          ? WorkflowDbController.buildAlias(requestData.levels)
          : null;

        let workflowName =
          requestData?.name || associatedWorkflow?.name || 'New Workflow';
        let alias =
          req.alias ||
          requestData?.alias ||
          fallbackAlias ||
          associatedWorkflow?.alias ||
          'N/A';
        let masterData: any = null;

        if (associatedWorkflow) {
          masterData = {
            name: associatedWorkflow.name,
            workflowType: associatedWorkflow.type,
            module: associatedWorkflow.module,
            subModule: associatedWorkflow.subModule,
            levelsHash: associatedWorkflow.levelsHash,
            status: associatedWorkflow.status,
            levels: associatedWorkflow.levels.reduce((acc: any, l: any) => {
              acc[`l${l.level}`] = {
                type: l.approverType,
                approver1: l.approver1,
                approver2: l.approver2,
              };
              return acc;
            }, {}),
          };
        }

        const rest = { ...req };
        if (req.type !== 'INITIATE' && masterData) {
          rest.data = {
            ...masterData,
            nodePath:
              associatedWorkflow?.orgStructure?.nodePath ||
              node?.nodePath ||
              requestData?.nodePath ||
              null,
          };
        }
        delete rest.workflowHistories;
        delete rest.approvalWorkflowId;

        const newDataObj =
          req.type === 'INITIATE'
            ? null
            : req.data
              ? { ...(req.data as any) }
              : null;
        if (newDataObj) {
          delete newDataObj.target;
          delete newDataObj.subModule;
        }

        return {
          ...rest,
          impact: req.impact ?? null,
          oldData: req.oldData || ((req.data as any)?.oldData ?? null),
          newData: newDataObj,
          initiator,
          initiatorTimestamp,
          nodeType,
          nodeName: node?.nodeName || (req.data as any)?.nodeName || null,
          nodePath: node?.nodePath || (req.data as any)?.nodePath || null,
          workflowName,
          alias,
          associateAlias: {
            workflowName:
              approvalWorkflow?.name ?? associatedWorkflow?.name ?? workflowName,
            workflowAlias:
              approvalWorkflow?.alias ?? associatedWorkflow?.alias ?? alias,
          },
          linkedOrgStructure,
        };
      });

      return res.status(200).json({
        data: pendingRequests,
        activeCount,
        pendingCount,
        inactiveCount,
        archiveCount,
        pageInfo: pageData.pageInfo,
      });
    } catch (error) {
      return next(error);
    }
  }
}
