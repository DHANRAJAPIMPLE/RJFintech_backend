import type { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../../shared/middlewares/error.middleware';
import { WorkflowApproverUtil } from '../../utils/workflow-approver.util';
import { NotificationService } from '../notifications/notification.db.modules';
import { HistoryUserUtil } from '../../utils/history-user.util';
import {
  appendCursorWhere,
  buildPage,
  getInMemoryPageRows,
  getPageOrder,
  isRowInCursorDirection,
  resolveCursorPagination,
} from '../../../shared/utils/cursor-pagination.util';

type WorkflowTarget = {
  module: string;
  subModule: string;
  nodePath: string;
  levelsHash: string;
};

/**
 * Controller for handling workflow-related database operations.
 * Manages the lifecycle of workflow requests (initiation, approval/rejection)
 * and the retrieval of active workflows and their histories.
 */
export class WorkflowDbController {
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
        select: { id: true, type: true, initiator: { select: { email: true } } },
        take: 11,
      }),
      client.orgStructureReq.findMany({
        where: { workflowId, status: 'PENDING' },
        select: { id: true, type: true, initiator: { select: { email: true } } },
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
        select: { id: true, type: true, initiator: { select: { email: true } } },
        take: 11,
      }),
    ]);

    const combined = [...userRequests, ...orgRequests, ...workflowRequests];
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
        `Cannot inactivate workflow '${workflowName || workflowId}' (Levels: ${alias || 'N/A'}) because it is currently protecting ${combined.length} pending approval request(s). Please process these pending requests or route them to a different workflow before inactivating:\n${lines}${remainingLine}`,
        409,
      );
    }
  }

  private static async assertSelectedWorkflowNotPendingModification(
    client: any,
    companyId: string,
    parentLevelsHash?: string | null,
  ) {
    const selectedWorkflow = await client.workflow.findFirst({
      where: {
        companyId,
        module: 'SYSTEM_ACCESS',
        subModule: 'WORK_FLOW',
        status: 'ACTIVE',
        ...(parentLevelsHash
          ? { levelsHash: parentLevelsHash }
          : { name: { contains: 'DEFAULT' } }),
      },
      orderBy: parentLevelsHash ? undefined : { createdAt: 'desc' },
      select: {
        module: true,
        subModule: true,
        levelsHash: true,
        orgStructure: { select: { nodePath: true } },
      },
    });

    if (!selectedWorkflow && parentLevelsHash) {
      throw new AppError(
        `Workflow with hash '${parentLevelsHash}' not found for this company`,
        404,
      );
    }
    if (!selectedWorkflow) return;

    await WorkflowDbController.assertTargetNotPendingModification(
      client,
      companyId,
      {
        module: selectedWorkflow.module,
        subModule: selectedWorkflow.subModule,
        nodePath: selectedWorkflow.orgStructure.nodePath,
        levelsHash: selectedWorkflow.levelsHash,
      },
      'Selected approval workflow has a pending modification',
    );
  }

  private static async assertTargetNotPendingModification(
    client: any,
    companyId: string,
    target: WorkflowTarget,
    message = 'Workflow already has a pending modification',
  ) {
    const pendingRequests = await client.workflowReq.findMany({
      where: {
        companyId,
        status: 'PENDING',
        type: { in: ['UPDATE', 'INACTIVE'] },
      },
      select: {
        id: true,
        alias: true,
        data: true,
        createdAt: true,
        initiator: { select: { name: true, email: true } },
      },
    });
    const pendingTargetRequest = pendingRequests.find((request: any) => {
      const pendingTarget = (request.data as any)?.target;
      return (
        pendingTarget?.module === target.module &&
        pendingTarget?.subModule === target.subModule &&
        pendingTarget?.nodePath === target.nodePath &&
        pendingTarget?.levelsHash === target.levelsHash
      );
    });

    if (pendingTargetRequest) {
      if (message !== 'Workflow already has a pending modification') {
        throw new AppError(message, 409);
      }
      const pendingAlias =
        pendingTargetRequest.alias ||
        (pendingTargetRequest.data as any)?.alias ||
        pendingTargetRequest.id;
      const initiator = pendingTargetRequest.initiator;
      const workflowName =
        (pendingTargetRequest.data as any)?.name || target.levelsHash;
      throw new AppError(
        `Cannot modify or inactivate workflow '${workflowName}'. A matching workflow request '${pendingAlias}' is already pending approval. Initiated by ${initiator?.name || 'Unknown'} (${initiator?.email || 'unknown'}) on ${WorkflowDbController.formatConflictDate(pendingTargetRequest.createdAt)}. Please resolve or cancel that request first.`,
        409,
      );
    }
  }

  private static async createModificationRequest(input: {
    initiatorId: string;
    companyId: string;
    type: 'UPDATE' | 'INACTIVE';
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
            status: 'ACTIVE',
          },
          include: {
            orgStructure: true,
            levels: { orderBy: { level: 'asc' } },
          },
        })
      : null;

    if (!target) {
      throw new AppError('Active workflow not found', 404);
    }

    if (target.alias === '1M_1C_D' || target.name.includes('DEFAULT')) {
      throw new AppError('Default workflow cannot be modified', 400);
    }

    await WorkflowDbController.assertTargetNotPendingModification(
      prisma,
      companyId,
      requestedTarget,
    );

    await Promise.all([
      WorkflowDbController.assertWorkflowNotUsedInPendingApproval(
        prisma,
        target.id,
        target.name,
        target.alias,
      ),
      WorkflowDbController.assertSelectedWorkflowNotPendingModification(
        prisma,
        companyId,
        parentLevelsHash,
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

    const proposedLevelsHash =
      WorkflowDbController.buildLevelsHash(proposedLevels);
    const currentData = {
      name: target.name,
      module: target.module,
      subModule: target.subModule,
      nodePath: target.orgStructure.nodePath,
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
      levels: proposedLevels,
      levelsHash: proposedLevelsHash,
      alias: WorkflowDbController.buildAlias(proposedLevels),
      status: type === 'INACTIVE' ? 'INACTIVE' : currentData.status,
    };

    if (
      type === 'UPDATE' &&
      JSON.stringify(currentData) === JSON.stringify(newData)
    ) {
      throw new AppError('Workflow update does not change any values', 400);
    }

    const oldData: Record<string, unknown> = {};
    for (const field of ['name', 'module', 'subModule', 'nodePath', 'status']) {
      if ((currentData as any)[field] !== (newData as any)[field]) {
        oldData[field] = (currentData as any)[field];
      }
    }
    if (JSON.stringify(currentData.levels) !== JSON.stringify(newData.levels)) {
      oldData.levels = currentData.levels;
      oldData.levelsHash = currentData.levelsHash;
      oldData.alias = currentData.alias;
    }

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
      ...(type === 'INACTIVE' ? { status: 'INACTIVE' } : {}),
    };
    let notificationRecipients: string[] = [];
    const request = await prisma.$transaction(async (tx) => {
      const created = await tx.workflowReq.create({
        data: {
          companyId,
          nodeId: proposedNode.id,
          module: newData.module,
          subModule: newData.subModule,
          levelsHash: newData.levelsHash,
          type,
          impact: type === 'INACTIVE' ? 'INACTIVE' : 'WORKFLOW_UPDATE',
          initiatorId,
          data: requestData as any,
          oldData: oldData as any,
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
      await tx.workflowReq.update({
        where: { id: created.id },
        data: {
          workflowId: approval.workflowId,
        },
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
      return created;
    });

    await NotificationService.createRequestNotification({
      companyId,
      type: 'INITIATE',
      referenceType: 'WORKFLOW',
      referenceId: request.id,
      referenceName: newData.name,
      createdBy: initiatorId,
      recipientUserIds: notificationRecipients,
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
            status: 'ACTIVE',
          },
          include: { levels: { orderBy: { level: 'asc' } } },
        })
      : null;
    if (!target) {
      throw new AppError('Active target workflow no longer exists', 409);
    }

    await Promise.all([
      WorkflowDbController.assertFinalApproversRemainEligible(
        tx,
        request.id,
        request.companyId,
      ),
      WorkflowDbController.assertWorkflowNotUsedInPendingApproval(
        tx,
        target.id,
        target.name,
        target.alias,
        request.id,
      ),
    ]);

    if (request.type === 'INACTIVE') {
      await tx.workflow.update({
        where: { id: target.id },
        data: {
          status: 'INACTIVE',
          workflowReqIds: { push: request.id },
        },
      });
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
      if (
        calculatedHash !== nextData.levelsHash ||
        calculatedHash !== request.levelsHash
      ) {
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
      await tx.workflow.update({
        where: { id: target.id },
        data: {
          name: nextData.name,
          alias: nextData.alias,
          module: nextData.module,
          subModule: nextData.subModule,
          roleCode: roleRecord?.roleCode || null,
          nodeId: node.id,
          levelsHash: calculatedHash,
          workflowReqIds: { push: request.id },
        },
      });
      await tx.workflowLevel.deleteMany({ where: { workflowId: target.id } });

      const levelData = Object.entries(nextData.levels || {})
        .filter(([, level]) => Boolean(level))
        .map(([key, level]) => {
          const configured = level as any;
          return {
            workflowId: target.id,
            level: parseInt(key.replace('l', ''), 10),
            approver1: configured.approver1,
            approver2: configured.approver2 || null,
            approverType: configured.type || 'OR',
          };
        });
      if (levelData.length > 0) {
        await tx.workflowLevel.createMany({ data: levelData });
      }
    }

    return tx.workflowReq.update({
      where: { id: request.id },
      data: { status: 'APPROVED', approvalRemark: remark },
    });
  }

  // --- Internal Atomic Operations ---

  /**
   * Fetches a single workflow request by its unique ID.
   * Includes the associated company details for context.
   */
  static async getWorkflowRequestByHash(req: Request, res: Response) {
    const { id, levelsHash, companyId } = req.body;
    const request = await prisma.workflowReq.findFirst({
      where: {
        ...(id ? { id } : { levelsHash }),
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

      if (type === 'UPDATE' || type === 'INACTIVE') {
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
          const signatories = await prisma.userAccess.findMany({
            where: { companyId: resolvedCompanyId, isGlobalAccess: true },
            select: { userId: true },
          });
          const recipients = NotificationService.mergeRecipientUserIds(
            initiatorId,
            signatories.map((row) => row.userId),
          );
          await NotificationService.createRequestNotification({
            companyId: resolvedCompanyId,
            type: 'INITIATE',
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
          }).catch(() => undefined);
          throw error;
        }
      }

      const { module, subModule, nodePath, levels } = data;

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

      // 2. Block if ACTIVE duplicate exists
      const alreadyActive = await prisma.workflow.findUnique({
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
      });
      if (alreadyActive) {
        throw new AppError(`Already active: "${alreadyActive.name}"`, 409);
      }

      // 3. Block if PENDING duplicate exists
      const alreadyPending = await prisma.workflowReq.findFirst({
        where: {
          companyId: resolvedCompanyId,
          nodeId,
          module,
          subModule,
          levelsHash,
          status: 'PENDING',
        },
      });
      if (alreadyPending) {
        throw new AppError(`Already pending: ${alreadyPending.id}`, 409);
      }

      await WorkflowDbController.assertSelectedWorkflowNotPendingModification(
        prisma,
        resolvedCompanyId,
        parentLevelsHash,
      );

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

      const generatedAlias = WorkflowDbController.buildAlias(levels);

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
            data,
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

          // Store the resolved workflowId in the request record
          await tx.workflowReq.update({
            where: { id: request.id },
            data: { workflowId: resolvedWorkflowId },
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
        referenceName: data?.name,
        createdBy: initiatorId,
        recipientUserIds: notificationRecipients,
      });

      res.status(201).json(result);
    } catch (error) {
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
      } = req.body;

      // ── Find the pending request by levelsHash ──────────────────────────
      const request = await prisma.workflowReq.findFirst({
        where: {
          ...(requestId ? { id: requestId } : { levelsHash }),
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
      const id = request.id;
      let notificationRecipients = request.eligibleApprovers || [];

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
        if (initiatorLog && initiatorLog.eventUserId === approverId) {
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

          if (request.type === 'UPDATE' || request.type === 'INACTIVE') {
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

          // Block if ACTIVE duplicate exists
          const alreadyActive = await tx.workflow.findUnique({
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
          });
          if (alreadyActive) {
            throw new AppError(`Already active: "${alreadyActive.name}"`, 409);
          }

          // Block if OTHER PENDING duplicates exist
          const alreadyPending = await tx.workflowReq.findFirst({
            where: {
              companyId,
              nodeId,
              module,
              subModule,
              levelsHash,
              status: 'PENDING',
              id: { not: id },
            },
          });
          if (alreadyPending) {
            throw new AppError(`Already pending: ${alreadyPending.id}`, 409);
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
              levelsHash: request.levelsHash,
              workflowReqIds: [id],
            },
          });

          // 4. Create the specific Approval Levels for this workflow
          if (levels) {
            const levelData = [];
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
            if (levelData.length > 0) {
              await tx.workflowLevel.createMany({ data: levelData });
            }
          }

          // 5. Finalize the request status
          const updated = await tx.workflowReq.update({
            where: { id },
            data: {
              status: 'APPROVED',
              approvalRemark: remark,
            },
          });

          return { ...updated, status: 'APPROVED' };
        }

        throw new Error('Invalid status');
      });

      let message = `Workflow request ${status.toLowerCase()}ed successfully`;
      if (result && result.status === 'PARTIAL_APPROVED') {
        message = `Workflow request approved at Level ${result.level}, pending remaining approval`;
      } else if (result && result.status === 'APPROVED') {
        message = 'Workflow request approved successfully';
      } else if (result && result.status === 'REJECTED') {
        message = 'Workflow request rejected successfully';
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
      const notificationRecipientUserIds =
        NotificationService.mergeRecipientUserIds(
          notificationRecipients,
          requestInitiatorId,
        );

      await NotificationService.createRequestNotification({
        companyId: request.companyId,
        type:
          result?.status === 'REJECTED'
            ? 'REJECT'
            : result?.status === 'APPROVED'
              ? 'ONBOARDED'
              : 'APPROVE',
        referenceType: 'WORKFLOW',
        referenceId: request.id,
        referenceName: (request.data as any)?.name,
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
        levelsHash,
        module,
        subModule,
        nodePath,
        userId,
      } = req.body;
      let whereCondition: any = {};

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

      // If specific identifiers are provided, filter the history strictly
      if (levelsHash || module || subModule || nodePath) {
        let nodeId: string | undefined;
        if (nodePath) {
          const node = await prisma.orgStructure.findFirst({
            where: { nodePath, companyId: resolvedCompanyId },
          });
          nodeId = node?.id;
        }

        const reqs = await prisma.workflowReq.findMany({
          where: {
            companyId: resolvedCompanyId,
            levelsHash: levelsHash || undefined,
            module: module || undefined,
            subModule: subModule || undefined,
            nodeId: nodeId || undefined,
            // Restrict by user's nodes if not global
            ...(isGlobal ? {} : { nodeId: { in: userNodeIds } }),
          },
          select: { id: true },
        });

        whereCondition = {
          workflowReqId: { in: reqs.map((r) => r.id) },
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

      // Filter out rejected workflows
      const rejectedReqIds = new Set<string>();
      histories.forEach((h) => {
        if (
          h.workflowReqId &&
          (h.event === 'REJECTED' || h.workflowReq?.status === 'REJECTED')
        ) {
          rejectedReqIds.add(h.workflowReqId);
        }
      });

      histories = histories.filter(
        (h) => !h.workflowReqId || !rejectedReqIds.has(h.workflowReqId),
      );

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

      // 3. Inject "Pending Approval" entries for any active requests
      histories.forEach((h) => {
        if (h.workflowReqId && !handledPendingReqs.has(h.workflowReqId)) {
          const levels = workflowMap.get(h.workflowReqId);
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
                workflowReqId: h.workflowReqId,
                workflowId: h.workflowReq?.workflowId || null,
                type: h.workflowReq?.type || null,
                impact: h.workflowReq?.impact || null,
                oldData:
                  h.workflowReq?.oldData ||
                  ((h.workflowReq?.data as any)?.oldData ?? null),
                newData: h.workflowReq?.data || null,
                nodeId: h.workflowReq?.nodeId || null,
                workflowName: (h.workflowReq?.data as any)?.name || null,
                module: h.workflowReq?.module || null,
                subModule: h.workflowReq?.subModule || null,
                levelsHash: h.workflowReq?.levelsHash || null,
                alias: h.workflowReq?.alias || null,
                nodePath: (h.workflowReq?.data as any)?.nodePath || null,
                nodeName: (h.workflowReq?.data as any)?.nodeName || null,
                nodeType: (h.workflowReq?.data as any)?.nodeType || null,
                companyCode: h.company.companyCode,
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
        return {
          workflowReqId: h.workflowReqId,
          workflowId: h.workflowReq?.workflowId || null,
          type: h.workflowReq?.type || null,
          impact: h.workflowReq?.impact || null,
          oldData:
            h.workflowReq?.oldData ||
            ((h.workflowReq?.data as any)?.oldData ?? null),
          newData: h.workflowReq?.data || null,
          nodeId: h.workflowReq?.nodeId || null,
          workflowName: (h.workflowReq?.data as any)?.name || null,
          module: h.workflowReq?.module || null,
          subModule: h.workflowReq?.subModule || null,
          levelsHash: h.workflowReq?.levelsHash || null,
          alias: h.workflowReq?.alias || null,
          nodePath: (h.workflowReq?.data as any)?.nodePath || null,
          nodeName: (h.workflowReq?.data as any)?.nodeName || null,
          nodeType: (h.workflowReq?.data as any)?.nodeType || null,
          companyCode: h.company.companyCode,
          event: h.event,
          level: h.level,
          createdAt: h.createdAt,
          remarks: h.remarks,
          user: HistoryUserUtil.formatAuditUser(
            h.user,
            h.eventUserId,
            saasAdminUserIds,
            userId,
          ),
        };
      });

      resultList.push(...formattedHistories);

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

      const activeWhere: any = {
        companyId: resolvedCompanyId,
        status: 'ACTIVE',
        AND: [
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
      };
      const pendingWhere: any = {
        companyId: resolvedCompanyId,
        status: 'PENDING',
        ...(isGlobal ? {} : { nodeId: { in: userNodeIds } }),
      };
      const inactiveWhere: any = {
        companyId: resolvedCompanyId,
        status: 'INACTIVE',
        AND: [
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
      };
      const approverRows = userId
        ? await prisma.workflowApprover.findMany({
            where: { reqTable: 'workflow_req', status: 'PENDING' },
            select: { reqId: true, approversList: true },
          })
        : [];
      const approverRequestIds = approverRows
        .filter(
          (row) =>
            Array.isArray(row.approversList) &&
            row.approversList.includes(userId),
        )
        .map((row) => row.reqId);
      const initiatorRequestIds = userId
        ? (
            await prisma.workflowReq.findMany({
              where: {
                companyId: resolvedCompanyId,
                status: 'PENDING',
                initiatorId: userId,
                type: { in: ['UPDATE', 'INACTIVE'] },
              },
              select: { id: true },
            })
          ).map((row) => row.id)
        : [];
      const visiblePendingRequestIds = Array.from(
        new Set([...approverRequestIds, ...initiatorRequestIds]),
      );
      const pendingListWhere: any = {
        ...pendingWhere,
        ...(visiblePendingRequestIds.length > 0
          ? {
              OR: [
                { type: 'INITIATE' },
                { id: { in: visiblePendingRequestIds } },
              ],
            }
          : { type: 'INITIATE' }),
      };
      const listWhere =
        type === 'pending'
          ? pendingListWhere
          : type === 'inactive'
            ? inactiveWhere
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
        data: true,
        oldData: true,
        type: true,
        status: true,
        alias: true,
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
              new Set(requests.map((request) => request.nodeId).filter(Boolean)),
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
      const [activeCount, pendingCount, inactiveCount, selectedRows, newCount] =
        await Promise.all([
          prisma.workflow.count({ where: activeWhere }),
          filteredPendingRows
            ? Promise.resolve(filteredPendingRows.length)
            : prisma.workflowReq.count({ where: pendingListWhere }),
          prisma.workflow.count({ where: inactiveWhere }),
          type === 'active' || type === 'inactive'
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
            ? type === 'active' || type === 'inactive'
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
          type === 'active' || type === 'inactive'
            ? await prisma.workflow.count({ where: newerWhere })
            : filteredPendingRows
              ? filteredPendingRows.filter((request) =>
                  isRowInCursorDirection(request, firstPageRow, 'newer'),
                ).length
              : await prisma.workflowReq.count({ where: newerWhere });
        pageData.pageInfo.page = Math.floor(newerCount / pagination.limit) + 1;
      }

      if (type === 'active' || type === 'inactive') {
        const activeRows = pageData.pageRows as any[];
        const activeIds = activeRows.map((workflow) => workflow.id);
        const activeKeys = new Set(
          activeRows.map((workflow) =>
            [
              workflow.module,
              workflow.subModule,
              workflow.orgStructure?.nodePath,
              workflow.levelsHash,
            ].join('|'),
          ),
        );
        const pendingModifications =
          type === 'active' &&
          activeIds.length > 0 &&
          visiblePendingRequestIds.length > 0
            ? await prisma.workflowReq.findMany({
                where: {
                  companyId: resolvedCompanyId,
                  status: 'PENDING',
                  type: { in: ['UPDATE', 'INACTIVE'] },
                  id: { in: visiblePendingRequestIds },
                },
                select: pendingSelect,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              })
            : [];
        const pendingByWorkflowId = new Map<string, any>();
        const pendingByTargetKey = new Map<string, any>();
        pendingModifications.forEach((request: any) => {
          if (request.workflowId && !pendingByWorkflowId.has(request.workflowId)) {
            pendingByWorkflowId.set(request.workflowId, request);
          }
          const target = (request.data as any)?.target;
          const key = [
            target?.module,
            target?.subModule,
            target?.nodePath,
            target?.levelsHash,
          ].join('|');
          if (activeKeys.has(key) && !pendingByTargetKey.has(key)) {
            pendingByTargetKey.set(key, request);
          }
        });
        const activeWithPending = activeRows.map((workflow) => {
          const key = [
            workflow.module,
            workflow.subModule,
            workflow.orgStructure?.nodePath,
            workflow.levelsHash,
          ].join('|');
          const pending =
            pendingByWorkflowId.get(workflow.id) || pendingByTargetKey.get(key);

          return {
            ...workflow,
            pendingRequest: pending
              ? {
                  id: pending.id,
                  type: pending.type,
                  impact: pending.impact ?? null,
                  status: pending.status,
                  oldData:
                    pending.oldData || ((pending.data as any)?.oldData ?? null),
                  newData: pending.data || null,
                  createdAt: pending.createdAt,
                }
              : null,
          };
        });

        return res.status(200).json({
          data: activeWithPending,
          activeCount,
          pendingCount,
          inactiveCount,
          pageInfo: pageData.pageInfo,
        });
      }

      const pendingRequestsRaw = pageData.pageRows as any[];
      const workflowIds = Array.from(
        new Set(
          pendingRequestsRaw.map((req) => req.workflowId).filter(Boolean),
        ),
      ) as string[];
      const nodeIds = Array.from(
        new Set(pendingRequestsRaw.map((req) => req.nodeId)),
      ) as string[];

      const [workflowDetails, nodeDetails] = await Promise.all([
        prisma.workflow.findMany({
          where: { id: { in: workflowIds } },
          select: { id: true, name: true, alias: true },
        }),
        prisma.orgStructure.findMany({
          where: { id: { in: nodeIds } },
          select: { id: true, nodeName: true, nodePath: true, nodeType: true },
        }),
      ]);

      const workflowMap = new Map(workflowDetails.map((w) => [w.id, w]));
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

        // Resolve workflow name and alias
        let workflowName = (req.data as any)?.name || 'New Workflow';
        let alias = req.alias || (req.data as any)?.alias || 'N/A';

        if (req.workflowId) {
          const w = workflowMap.get(req.workflowId);
          if (w) {
            workflowName = w.name;
            alias = w.alias;
          }
        }

        const rest = { ...req };
        delete rest.workflowHistories;
        return {
          ...rest,
          impact: req.impact ?? null,
          oldData: req.oldData || ((req.data as any)?.oldData ?? null),
          newData: req.type === 'INITIATE' ? null : (req.data || null),
          initiator,
          initiatorTimestamp,
          nodeType,
          nodeName: node?.nodeName || (req.data as any)?.nodeName || null,
          nodePath: node?.nodePath || (req.data as any)?.nodePath || null,
          workflowName,
          alias,
        };
      });

      return res.status(200).json({
        data: pendingRequests,
        activeCount,
        pendingCount,
        inactiveCount,
        pageInfo: pageData.pageInfo,
      });
    } catch (error) {
      return next(error);
    }
  }
}


