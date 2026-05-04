import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../../lib/prisma';

/**
 * Controller for handling workflow-related database operations.
 * Manages the lifecycle of workflow requests (initiation, approval/rejection)
 * and the retrieval of active workflows and their histories.
 */
export class WorkflowDbController {
  // --- Internal Atomic Operations ---

  /**
   * Fetches a single workflow request by its unique ID.
   * Includes the associated company details for context.
   */
  static async getWorkflowRequestById(req: Request, res: Response) {
    const { id } = req.body;
    const request = await prisma.workflowReq.findUnique({
      where: { id },
      include: { company: true },
    });
    res.json(request);
  }

  // --- Transactional Commit Operations ---

  /**
   * Initiates a new workflow onboarding request.
   * Performs an atomic transaction to:
   * 1. Create a WorkflowReq entry with the provided payload and eligible approvers.
   * 2. Log the 'INITIATE' event in the WorkflowReqHistory table.
   */
  static async initiateWorkflowRequest(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { initiatorId, companyId, data, eligibleApprovers } = req.body;

      const result = await prisma.$transaction(async (tx) => {
        const request = await tx.workflowReq.create({
          data: {
            companyId,
            data,
            status: 'PENDING',
            eligibleApprovers,
          },
          include: { company: true },
        });

        // Record the initiation in history for auditing
        await tx.workflowReqHistory.create({
          data: {
            workflowReqId: request.id,
            companyCode: request.company.companyCode,
            event: 'INITIATE',
            eventUserId: initiatorId,
          },
        });

        return request;
      });

      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Processes an action (APPROVE/REJECT) on a pending workflow request.
   * Uses an atomic transaction to ensure data integrity across multiple tables.
   */
  static async actionWorkflowRequest(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { id, status, approverId, remark } = req.body;

      const result = await prisma.$transaction(async (tx) => {
        // 1. Fetch the request to validate existence and get company info
        const request = await tx.workflowReq.findUnique({
          where: { id },
          include: { company: true },
        });

        if (!request) throw new Error('Request not found');

        // --- REJECT FLOW ---
        // Marks the request as REJECTED and logs the history.
        if (status.toLowerCase() === 'reject') {
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
              companyCode: request.company.companyCode,
              event: 'REJECTED',
              eventUserId: approverId,
            },
          });

          return updated;
        }

        // --- APPROVE FLOW ---
        // Converts the request into an active Workflow and setup its approval levels.
        if (status.toLowerCase() === 'approve') {
          const data = request.data as any;
          const { name, module, subModule, nodePath, levels } = data;

          // 1. Resolve the organizational node from the path
          const node = await tx.orgStructure.findUnique({
            where: { nodePath },
          });

          if (!node) throw new Error(`Node path '${nodePath}' not found`);

          // 2. Generate Workflow Alias: 1M_{TotalApprovers}C_{TotalLevels}
          // logic: 'AND' levels with 2 approvers = 2, 'OR' or 1 approver = 1.
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
          // workflowReqIds is a manual array tracking the requests that formed this workflow
          const workflow = await tx.workflow.create({
            data: {
              name,
              alias: generatedAlias,
              module,
              subModule,
              companyId: request.companyId,
              nodeId: node.id,
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

          // 5. Finalize the request status and audit log
          const updated = await tx.workflowReq.update({
            where: { id },
            data: {
              status: 'APPROVED',
              approvalRemark: remark,
            },
          });

          await tx.workflowReqHistory.create({
            data: {
              workflowReqId: id,
              companyCode: request.company.companyCode,
              event: 'APPROVED',
              eventUserId: approverId,
            },
          });

          return updated;
        }

        throw new Error('Invalid status');
      });

      res.status(200).json(result);
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
      const { companyCode, workflowId } = req.body;
      let whereCondition: any = {};

      // If workflowId is provided, we fetch history for all requests linked to that workflow
      if (workflowId) {
        const workflow = await prisma.workflow.findUnique({
          where: { id: workflowId },
          select: { workflowReqIds: true },
        });

        if (!workflow) {
          return res.status(404).json({ error: 'Workflow not found' });
        }

        whereCondition = {
          workflowReqId: { in: workflow.workflowReqIds },
        };
      } else if (companyCode) {
        // Fallback to company-wide history
        whereCondition = { companyCode };
      } else {
        return res
          .status(400)
          .json({ error: 'companyCode or workflowId is required' });
      }

      const histories = await prisma.workflowReqHistory.findMany({
        where: whereCondition,
        include: {
          user: { select: { name: true, email: true } },
          workflowReq: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      // Format the output for the UI
      const formattedHistories = histories.map((h) => ({
        companyCode: h.companyCode,
        event: h.event,
        createdAt: h.createdAt,
        user: h.user,
        workflowName: (h.workflowReq?.data as any)?.name || 'N/A',
      }));

      res.json(formattedHistories);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Fetches all workflow-related data for a company.
   * Returns:
   * 1. 'active': Fully approved workflows currently in use.
   * 2. 'pending': Onboarding requests awaiting approval.
   */
  static async fetchWorkflows(req: Request, res: Response, next: NextFunction) {
    try {
      const { companyId } = req.body;

      // Active production workflows
      const activeWorkflows = await prisma.workflow.findMany({
        where: { companyId },
        include: {
          orgStructure: true,
          levels: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      // Pending onboarding requests
      const pendingRequests = await prisma.workflowReq.findMany({
        where: {
          companyId,
          status: 'PENDING',
        },
        include: {
          workflowHistories: {
            where: { event: 'INITIATE' },
            include: { user: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      res.status(200).json({
        active: activeWorkflows,
        pending: pendingRequests,
      });
    } catch (error) {
      next(error);
    }
  }
}
