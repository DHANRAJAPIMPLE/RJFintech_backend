import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../../lib/prisma';
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
        id, 'org_structure_req',
      );

      // If workflow approver rows exist, enforce level-wise checks
      if (currentLevel) {
        const approversList = currentLevel.approversList as string[];
        if (Array.isArray(approversList) && !approversList.includes(approverId)) {
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
        if (status.toUpperCase() === 'REJECTED') {
          // Reject all remaining approval levels
          await WorkflowApproverUtil.rejectAllLevels(tx, id, 'org_structure_req');

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
              },
            });
          }

          return updated;
        }

        // --- APPROVE FLOW ---
        if (status.toUpperCase() === 'APPROVED') {
          // ── Level-wise approval: mark current level as APPROVED ──────────
          let allLevelsApproved = true;
          const approvedLevel = currentLevel?.level || null;

          if (currentLevel) {
            const nextLevel = await WorkflowApproverUtil.approveLevel(
              tx, id, 'org_structure_req', currentLevel.level,
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
            },
          });

          // If NOT all levels approved, return early (partial approval)
          if (!allLevelsApproved) {
            return { id: request.id, status: 'PARTIAL_APPROVED' };
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

          // Propagate user access from parent nodes to the new node
          const pathParts = newNodePath.split('.');
          const parentPaths = [];
          let currentPath = '';
          for (let i = 0; i < pathParts.length - 1; i++) {
            currentPath += (i === 0 ? '' : '.') + pathParts[i];
            parentPaths.push(currentPath);
          }

          if (parentPaths.length > 0) {
            // Find parent node IDs
            const parentNodes = await tx.orgStructure.findMany({
              where: {
                companyId: request.companyId,
                nodePath: { in: parentPaths },
              },
            });
            const parentNodeIds = parentNodes.map((n) => n.id);

            if (parentNodeIds.length > 0) {
              // Find all user access entries for parent nodes with isGlobalAccess = false
              const parentAccesses = await tx.userAccess.findMany({
                where: {
                  companyId: request.companyId,
                  nodeId: { in: parentNodeIds },
                  isGlobalAccess: false,
                },
              });

              // Prepare new entries, ensuring uniqueness to avoid constraint violations
              const newAccessesMap = new Map();
              for (const access of parentAccesses) {
                const uniqueKey = `${access.userId}_${access.roleCode}`;
                if (!newAccessesMap.has(uniqueKey)) {
                  newAccessesMap.set(uniqueKey, {
                    userId: access.userId,
                    roleCode: access.roleCode,
                    nodeId: newNode.id,
                    accessType: 'SECONDARY',
                    accessCategory: access.accessCategory,
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

          return updated;
        }

        throw new Error('Invalid status value');
      });

      res.status(200).json({
        success: true,
        message:
          status === 'approved'
            ? 'Org structure approved'
            : 'Org structure rejected',
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
      const { initiatorId, companyCode, companyId, workflowId, ...rest } = req.body;
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

      // Filter out the initiator from eligible approvers — initiator cannot approve their own request
      if (initiatorId && rest.eligibleApprovers) {
        rest.eligibleApprovers = rest.eligibleApprovers.filter(
          (id: string) => id !== initiatorId,
        );
      }

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
            where: { nodePath: reqData.parentNode.nodePath, companyId: resolvedCompanyId },
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
          await WorkflowApproverUtil.resolveAndCreateApprovers(tx, {
            workflowId: workflowId || null,
            module: 'SYSTEM_ACCESS',
            subModule: 'ORG_STR',
            companyId: resolvedCompanyId,
            nodeId,
            initiatorId,
            reqId: reqRecord.id,
            reqTable: 'org_structure_req',
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
      const { companyCode, companyId, newNodeName, _nodeType, parentNode } = req.body;
      let resolvedCompanyId = companyId;

      if (!resolvedCompanyId) {
        if (!companyCode) {
          return res.status(400).json({ error: 'companyCode or companyId is required' });
        }

        const company = await prisma.company.findUnique({
          where: { companyCode },
        });
        if (!company) return res.status(404).json({ error: 'Company not found' });
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
      const { companyCode, companyId, nodeName } = req.body;
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

      if (nodeName) {
        // 1. Find all matching OrgStructureReq IDs first
        const matchingReqs = await prisma.orgStructureReq.findMany({
          where: {
            companyId: resolvedCompanyId,
            data: {
              path: ['newNodeName'],
              equals: nodeName,
            },
          },
          select: { id: true },
        });
      
        const reqIds = matchingReqs.map((r) => r.id);
        whereCondition.orgReqId = { in: reqIds };
      }

      const histories = await prisma.orgHistory.findMany({
        where: whereCondition,
        include: {
          user: { select: { name: true, email: true } },
          orgReq: true,
          company: { select: { companyCode: true, id: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
 
      // Format history for easy display
      const formattedHistories = histories.map((h) => {
        const data = h.orgReq?.data as any;
        return {
          companyCode: h.company.companyCode,
          event: h.event,
          createdAt: h.createdAt,
          user: h.user,
          newNodeName: data?.newNodeName || null,
          nodeType: data?._nodeType || data?.nodeType || null,
          parentNodePath: data?.parentNode?.nodePath || 'ROOT',
          parentNodeName: data?.parentNode?.nodeName || 'ROOT',
        };
      });

      res.json(formattedHistories);
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
            .json({ success: false, message: 'companyCode or companyId is required' });
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

      // 3. Remove internal UUIDs and format for the tree UI
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
          pending: pendingRequests,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}
