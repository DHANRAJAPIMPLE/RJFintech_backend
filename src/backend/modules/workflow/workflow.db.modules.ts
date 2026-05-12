import type { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../../shared/middlewares/error.middleware';
import { WorkflowApproverUtil } from '../../utils/workflow-approver.util';

/**
 * Controller for handling workflow-related database operations.
 * Manages the lifecycle of workflow requests (initiation, approval/rejection)
 * and the retrieval of active workflows and their histories.
 */
export class WorkflowDbController {
  private static buildLevelsHash(levels: any): string {
    const normalized = Object.keys(levels)
      .sort()
      .map((key) => ({
        approvers: [levels[key].approver1, levels[key].approver2 ?? null]
          .filter(Boolean)
          .sort(),
        type: levels[key].type ?? 'OR',
      }));

    return createHash('md5').update(JSON.stringify(normalized)).digest('hex');
  }

  // --- Internal Atomic Operations ---

  /**
   * Fetches a single workflow request by its unique ID.
   * Includes the associated company details for context.
   */
  static async getWorkflowRequestByHash(req: Request, res: Response) {
    const { levelsHash, companyId } = req.body;
    const request = await prisma.workflowReq.findFirst({
      where: { levelsHash, companyId, status: 'PENDING' },
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
      } = req.body;
      const { module, subModule, nodePath, levels } = data;

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

      // 1. Resolve Node ID
      const node = await prisma.orgStructure.findFirst({
        where: { nodePath, companyId },
      });
      if (!node)
        throw new Error(`Node path '${nodePath}' not found for this company`);

      const nodeId = node.id;
      const levelsHash = WorkflowDbController.buildLevelsHash(levels);

      // 2. Block if ACTIVE duplicate exists
      const alreadyActive = await prisma.workflow.findUnique({
        where: {
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

      // 3. Block if PENDING duplicate exists
      const alreadyPending = await prisma.workflowReq.findFirst({
        where: {
          companyId,
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

      // Filter out the initiator from eligible approvers — initiator cannot approve their own request
      const filteredApprovers = initiatorId
        ? eligibleApprovers.filter((id: string) => id !== initiatorId)
        : eligibleApprovers;

      // ── Generate Workflow Alias: 1M_{TotalApprovers}C_{TotalLevels} ───────
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

      const result = await prisma.$transaction(async (tx) => {
        const request = await tx.workflowReq.create({
          data: {
            companyId: resolvedCompanyId,
            nodeId,
            module,
            subModule,
            levelsHash,
            data,
            alias: generatedAlias,
            status: 'PENDING',
            eligibleApprovers: filteredApprovers,
          },
          include: { company: true },
        });

        // ── Resolve workflow approvers and create WorkflowApprover rows ──────
        if (initiatorId) {
          const { workflowId: resolvedWorkflowId } =
            await WorkflowApproverUtil.resolveAndCreateApprovers(tx, {
              levelsHash: parentLevelsHash || null,
              module: 'SYSTEM_ACCESS',
              subModule: 'WORK_FLOW',
              companyId: resolvedCompanyId,
              nodeId,
              initiatorId,
              reqId: request.id,
              reqTable: 'workflow_req',
            });

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
      const { levelsHash, companyId, status, approverId, remark } = req.body;

      // ── Find the pending request by levelsHash ──────────────────────────
      const request = await prisma.workflowReq.findFirst({
        where: { levelsHash, companyId, status: 'PENDING' },
        include: { company: true },
      });

      if (!request)
        throw new AppError(
          'Workflow request not found or already processed',
          404,
        );
      const id = request.id;

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
            );
            if (nextLevel) {
              allLevelsApproved = false;
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

          // ── DUPLICATE CHECKS (only for full approval) ──────────────────
          const { companyId, nodeId, module, subModule, levelsHash } = request;

          // Block if ACTIVE duplicate exists
          const alreadyActive = await tx.workflow.findUnique({
            where: {
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
        message = `Workflow request approved at Level ${result.level}, pending next level approval`;
      } else if (result && result.status === 'APPROVED') {
        message = 'Workflow request approved successfully';
      } else if (result && result.status === 'REJECTED') {
        message = 'Workflow request rejected successfully';
      }

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
      const { companyCode, companyId, levelsHash, module, subModule, nodePath, userId } = req.body;
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

      const histories = await prisma.workflowReqHistory.findMany({
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

      // 1. Collect all unique request IDs to fetch their workflow approval status
      const reqIds = Array.from(
        new Set(histories.map((h) => h.workflowReqId).filter(Boolean)),
      ) as string[];

      const workflowApprovers = await prisma.workflowApprover.findMany({
        where: { reqId: { in: reqIds } },
        orderBy: { level: 'asc' },
      });

      // 2. Resolve approver details (names/emails)
      const allApproverIds = new Set<string>();
      workflowApprovers.forEach((wa) => {
        if (Array.isArray(wa.approversList)) {
          wa.approversList.forEach((id: any) => allApproverIds.add(String(id)));
        }
      });
      const approverDetails = await prisma.user.findMany({
        where: { id: { in: Array.from(allApproverIds) } },
        select: { id: true, name: true, email: true },
      });
      const approverMap = new Map(approverDetails.map((u) => [u.id, u]));

      // Group workflow levels by reqId
      const workflowMap = new Map<string, any[]>();
      workflowApprovers.forEach((wa) => {
        const existing = workflowMap.get(wa.reqId) || [];
        existing.push(wa);
        workflowMap.set(wa.reqId, existing);
      });

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
                workflowName: (h.workflowReq?.data as any)?.name || null,
                module: h.workflowReq?.module || null,
                subModule: h.workflowReq?.subModule || null,
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
        const companyId = h.company.id;
        const initiatorAccesses =
          h.user?.userAccesses?.filter((a) => a.companyId === companyId) || [];

        const isSaasAdmin = initiatorAccesses.some(
          (a) => a.roleCode === 'SAAS_ADMIN',
        );
        const isTeams = isSaasAdmin || (!h.user && h.eventUserId === null);

        const levels = h.workflowReqId
          ? workflowMap.get(h.workflowReqId)
          : null;
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
              })),
          };
        }

        return {
          workflowName: (h.workflowReq?.data as any)?.name || null,
          module: h.workflowReq?.module || null,
          subModule: h.workflowReq?.subModule || null,
          companyCode: h.company.companyCode,
          event: h.event,
          level: h.level,
          createdAt: h.createdAt,
          remarks: h.remarks,
          user: isTeams
            ? { name: 'Teams', email: 'Teams' }
            : {
              name: h.user?.name || 'System',
              email: h.user?.email || 'system@internal',
            },
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
   * Fetches all workflow-related data for a company.
   * Returns:
   * 1. 'active': Fully approved workflows currently in use.
   * 2. 'pending': Onboarding requests awaiting approval.
   */
  static async fetchWorkflows(req: Request, res: Response, next: NextFunction) {
    try {
      const { companyCode, companyId, userId } = req.body;

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

      // Active production workflows
      const activeWorkflows = await prisma.workflow.findMany({
        where: {
          companyId: resolvedCompanyId,
          ...(isGlobal ? {} : { nodeId: { in: userNodeIds } }),
        },
        select: {
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
        },
        orderBy: { createdAt: 'desc' },
      });

      // Pending onboarding requests
      const pendingRequestsRaw = await prisma.workflowReq.findMany({
        where: {
          companyId: resolvedCompanyId,
          status: 'PENDING',
          ...(isGlobal ? {} : { nodeId: { in: userNodeIds } }),
        },
        select: {
          id: true,
          nodeId: true,
          data: true,
          status: true,
          alias: true,
          approvalRemark: true,
          levelsHash: true,
          createdAt: true,
          workflowHistories: {
            where: { event: 'INITIATE' },
            select: {
              createdAt: true,
              user: {
                select: {
                  name: true,
                  email: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      // 1. Resolve all unique workflow IDs and node IDs from pending requests
      const workflowIds = Array.from(new Set(pendingRequestsRaw.map(req => req.workflowId).filter(Boolean))) as string[];
      const nodeIds = Array.from(new Set(pendingRequestsRaw.map(req => req.nodeId))) as string[];

      const [workflowDetails, nodeDetails] = await Promise.all([
        prisma.workflow.findMany({
          where: { id: { in: workflowIds } },
          select: { id: true, name: true, alias: true }
        }),
        prisma.orgStructure.findMany({
          where: { id: { in: nodeIds } },
          select: { id: true, nodeType: true }
        })
      ]);

      const workflowMap = new Map(workflowDetails.map(w => [w.id, w]));
      const nodeMap = new Map(nodeDetails.map(n => [n.id, n]));

      // 2. Flatten initiator, node info, and workflow info for frontend
      const pendingRequests = pendingRequestsRaw.map((req) => {
        const historyEntry = req.workflowHistories[0];
        const initiator = historyEntry?.user || {
          name: '',
          email: '',
        };
        const initiatorTimestamp = historyEntry?.createdAt || req.createdAt;
        const nodeType = nodeMap.get(req.nodeId)?.nodeType || null;
        
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

        const { workflowHistories, ...rest } = req;
        return {
          ...rest,
          initiator,
          initiatorTimestamp,
          nodeType,
          workflowName,
          alias,
        };
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
