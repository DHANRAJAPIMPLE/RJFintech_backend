import type { Request, Response, NextFunction } from 'express';
import { prisma, ltree } from '../../lib/prisma';
import { AppError } from '../../middlewares/error.middleware';
import { WorkflowApproverUtil } from '../../utils/workflow-approver.util';

/**
 * Controller for managing the organizational hierarchy (nodes) for companies.
 * Handles the creation, approval, and retrieval of organization units (Roots, Groups, Locations, etc.)
 */
export class OrgStructureDbController {
  // --- Internal Atomic Operations ---

  /**
   * Fetches a specific organization structure request by ID.
   */
  static async getOrgRequestById(req: Request, res: Response) {
    const { id } = req.body;
    const request = await prisma.orgStructureReq.findUnique({
      where: { id },
      include: { company: true },
    });
    res.json(request);
  }

  /**
   * Fetches an active organization node by its unique nodePath.
   */
  static async getOrgNodeByPath(req: Request, res: Response) {
    const { nodePath } = req.body;
    const node = await prisma.orgStructure.findUnique({
      where: { nodePath },
    });
    res.json(node);
  }

  /**
   * Fetches an active organization node by path and company context.
   */
  static async getOrgNodeByPathCompanyId(req: Request, res: Response) {
    const { nodePath, companyId } = req.body;

    const node = await prisma.orgStructure.findFirst({
      where: { nodePath, companyId },
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
        status, // 'approved' | 'rejected'
        approverId,
        remarks,
        newNodePath,
        newNodeName,
        nodeType,
        parentId,
      } = req.body;

      if (!id || !status) {
        throw new Error('id and status are required');
      }

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
        const request = await tx.orgStructureReq.findUnique({
          where: { id },
          include: { company: true },
        });

        if (!request) throw new Error('Request not found');

        // --- Prevent Self-Approval ---
        // Block the initiator from approving their own request.
        const initiatorLog = await prisma.orgHistory.findFirst({
          where: { orgReqId: id, event: 'INITIATE' },
        });
        if (initiatorLog && initiatorLog.eventUserId === approverId) {
          throw new AppError('Initiator cannot approve their own request', 403);
        }

        // --- Prevent Double Approval ---
        const alreadyApproved = await WorkflowApproverUtil.isAlreadyApproved(tx, id, 'org_structure_req', approverId);
        if (alreadyApproved) {
          throw new AppError('You have already approved a previous level of this request', 403);
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
            );
            if (nextLevel) {
              allLevelsApproved = false;
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
            return { id: request.id, status: 'PARTIAL_APPROVED', level: approvedLevel };
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

          // Propagate user access from parent nodes using ltree concept
          const parentPaths = ltree.getAncestors(newNodePath);

          if (parentPaths.length > 0) {
            const parentNodes = await tx.orgStructure.findMany({
              where: {
                companyId: request.companyId,
                nodePath: { in: parentPaths },
              },
            });

            const parentNodeIds = parentNodes.map((n) => n.id);
            const directParentPath = ltree.getParent(newNodePath);
            const directParentId = parentNodes.find(n => n.nodePath === directParentPath)?.id;

            if (parentNodeIds.length > 0) {
              // Fetch only propagating access: 
              // - ALL_CHILD from any ancestor 
              // - IMMEDIATE_CHILD only from the direct parent
              const parentAccesses = await tx.userAccess.findMany({
                where: {
                  companyId: request.companyId,
                  nodeId: { in: parentNodeIds },
                  isGlobalAccess: false,
                  OR: [
                    { accessCategory: 'ALL_CHILD' },
                    directParentId ? { nodeId: directParentId, accessCategory: 'IMMEDIATE_CHILD' } : undefined
                  ].filter(Boolean) as any,
                },
              });

              // Prepare new entries, ensuring uniqueness
              const newAccessesMap = new Map();
              for (const access of parentAccesses) {
                const uniqueKey = `${access.userId}_${access.roleCode}`;
                if (!newAccessesMap.has(uniqueKey)) {
                  // Rule: IMMEDIATE_CHILD on parent becomes NODE on child
                  const newCategory = access.accessCategory === 'IMMEDIATE_CHILD' ? 'NODE' : access.accessCategory;
                  
                  newAccessesMap.set(uniqueKey, {
                    userId: access.userId,
                    roleCode: access.roleCode,
                    nodeId: newNode.id,
                    accessType: 'SECONDARY',
                    accessCategory: newCategory,
                    companyId: access.companyId,
                    isGlobalAccess: false,
                  });
                }
              }

              const newAccesses = Array.from(newAccessesMap.values());
              if (newAccesses.length > 0) {
                await tx.userAccess.createMany({
                  data: newAccesses,
                  skipDuplicates: true,
                });
              }
            }
          }

          // 2. Update the onboarding request status
          const updated = await tx.orgStructureReq.update({
            where: { id },
            data: {
              status: 'APPROVED',
              remarks,
            },
          });

          return { ...updated, status: 'APPROVED' };
        }

        throw new Error('Invalid status value');
      });

      let message = 'Org structure request processed';
      if (result && result.status === 'PARTIAL_APPROVED') {
        message = `Org structure request approved at Level ${result.level}, pending next level approval`;
      } else if (result && result.status === 'APPROVED') {
        message = 'Org structure request approved and node created';
      } else if (result && result.status === 'REJECTED') {
        message = 'Org structure request rejected';
      }

      res.status(200).json({
        success: true,
        message,
        data: result,
      });
    } catch (error) {
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
      const globalUsers = await WorkflowApproverUtil.getGlobalAccessUserIds(prisma as any, resolvedCompanyId, 'ORG_STR');

      // Filter out the initiator from eligible approvers — initiator cannot approve their own request
      const masterEligible = new Set([...(rest.eligibleApprovers || []), ...globalUsers]);
      if (initiatorId) {
        masterEligible.delete(initiatorId);
      }
      rest.eligibleApprovers = Array.from(masterEligible);

      const request = await prisma.$transaction(async (tx) => {
        const reqRecord = await tx.orgStructureReq.create({
          data: {
            ...rest,
            companyId: resolvedCompanyId,
          },
          include: { company: true },
        });

        // ── Resolve workflow approvers and create WorkflowApprover rows ──────
        // Determine node for approver resolution from the request data
        const reqData = rest.data || {};
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
          const { workflowId: resolvedWorkflowId } =
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
            companyId,
            nodePath: parentNode.nodePath,
            nodeName: parentNode.nodeName,
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
          companyId,
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
      const { companyCode, companyId, nodeName, nodePath } = req.body;
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

      if (nodeName || nodePath) {
        // 1. Resolve parent path if nodePath is likely the node's own path
        let parentPathForFilter = nodePath;
        let isRootSearch = false;

        if (nodeName && nodePath) {
          const safeName = nodeName.trim().replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase();
          if (nodePath.endsWith(safeName)) {
            const parts = nodePath.split('.');
            if (parts.length > 1) {
              parentPathForFilter = parts.slice(0, -1).join('.');
            } else {
              // If it's a single part path and matches safeName, it's a ROOT node request
              parentPathForFilter = undefined;
              isRootSearch = true;
            }
          }
        }

        // 2. Find all matching OrgStructureReq IDs first
        const matchingReqs = await prisma.orgStructureReq.findMany({
          where: {
            companyId: resolvedCompanyId,
            AND: [
              nodeName
                ? {
                    data: {
                      path: ['newNodeName'],
                      equals: nodeName,
                    },
                  }
                : {},
              isRootSearch
                ? {
                    data: {
                      path: ['nodeType'],
                      equals: 'ROOT',
                    },
                  }
                : (parentPathForFilter
                  ? {
                      data: {
                        path: ['parentNode', 'nodePath'],
                        equals: parentPathForFilter,
                      },
                    }
                  : {}),
            ].filter((obj) => Object.keys(obj).length > 0) as any,
          },
          select: { id: true },
        });

        const reqIds = matchingReqs.map((r) => r.id);
        whereCondition.orgReqId = { in: reqIds };
      }


      const histories = await prisma.orgHistory.findMany({
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

      // Build initiator map: reqId -> initiatorUserId (maker can't be checker)
      const initiatorMap = new Map<string, string>();
      histories.forEach((h) => {
        if (h.orgReqId && h.event === 'INITIATE' && h.eventUserId) {
          initiatorMap.set(h.orgReqId, h.eventUserId);
        }
      });
      console.log(`[OrgHistory] Built initiatorMap with ${initiatorMap.size} entries`);

      // Enrich each level's approversList with global access users
      for (const [reqId, levels] of workflowMap.entries()) {
        const initiatorId = initiatorMap.get(reqId) || null;
        for (const level of levels) {
          const storedList = Array.isArray(level.approversList)
            ? (level.approversList as string[])
            : [];
          level.approversList = await WorkflowApproverUtil.getEnrichedApproverIds(
            resolvedCompanyId,
            storedList,
            initiatorId,
            'ORG_STR',
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
          userAccesses: {
            select: { roleCode: true },
          },
        },
      });
      const approverMap = new Map(
        approverDetails.map((u) => {
          const isSaasAdmin = u.userAccesses.some(
            (a) => a.roleCode === 'SAAS_ADMIN',
          );
          return [
            u.id,
            {
              name: isSaasAdmin ? 'Teams' : u.name,
              email: isSaasAdmin ? 'Teams' : u.email,
            },
          ];
        }),
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
                companyCode: h.company.companyCode,
                event: `L${currentPending.level} Pending Approval`,
                createdAt: null,
                eligibleapprovers: approvers,
                newNodeName: data?.newNodeName || null,
                nodeType: data?._nodeType || data?.nodeType || null,
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
        const initiatorAccesses = h.user?.userAccesses || [];

        const isSaasAdmin = initiatorAccesses.some(
          (a) => a.roleCode === 'SAAS_ADMIN',
        );
        const isTeams = isSaasAdmin || (!h.user && h.eventUserId === null);

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
          newNodeName: data?.newNodeName || null,
          nodeType: data?._nodeType || data?.nodeType || null,
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
   * Fetches the complete organization structure and pending requests for a company.
   * Used to build the tree view in the UI.
   */
  static async fetchStructure(req: Request, res: Response, next: NextFunction) {
    try {
      const { companyCode, companyId } = req.body;
      let resolvedCompanyId = companyId;

      if (!resolvedCompanyId) {
        if (!companyCode) {
          return res
            .status(400)
            .json({
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
        where: { companyId: resolvedCompanyId },
        orderBy: { nodePath: 'asc' },
      });

      // 2. Fetch pending requests for parallel tracking
      const pendingRequests = await prisma.orgStructureReq.findMany({
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

      // 3. Resolve workflow names and aliases for pending requests
      const workflowIds = Array.from(new Set(pendingRequests.map(req => req.workflowId).filter(Boolean))) as string[];
      const workflowDetails = await prisma.workflow.findMany({
        where: { id: { in: workflowIds } },
        select: { id: true, name: true, alias: true }
      });
      const workflowMap = new Map(workflowDetails.map(w => [w.id, w]));

      const pendingWithDetails = pendingRequests.map((req) => {
        const w = req.workflowId ? workflowMap.get(req.workflowId) : null;
        const initiator = req.orgHistories[0]?.user || { name: '', email: '' };
        
        const { orgHistories, ...rest } = req;
        return {
          ...rest,
          initiator,
          workflowName: w?.name || 'N/A',
          alias: w?.alias || 'N/A',
        };
      });

      // 4. Remove internal UUIDs and format for the tree UI
      const safeNodes = nodes.map((node) => ({
        nodeName: node.nodeName,
        nodeType: node.nodeType,
        nodePath: node.nodePath,
      }));

      res.status(200).json({
        message: 'Organization structure fetched successfully!',
        code: 200,
        data: {
          nodes: safeNodes,
          pending: pendingWithDetails,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}
