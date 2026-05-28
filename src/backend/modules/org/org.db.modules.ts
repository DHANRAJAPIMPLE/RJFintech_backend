import type { Request, Response, NextFunction } from 'express';
import { prisma, ltree } from '../../lib/prisma';
import { AppError } from '../../middlewares/error.middleware';
import { WorkflowApproverUtil } from '../../utils/workflow-approver.util';
import { NotificationService } from '../notifications/notification.db.modules';
import { HistoryUserUtil } from '../../utils/history-user.util';

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

/**
 * Controller for managing the organizational hierarchy (nodes) for companies.
 * Handles the creation, approval, and retrieval of organization units (Roots, Groups, Locations, etc.)
 */
export class OrgStructureDbController {
  private static pathSegment(value: string) {
    return value
      .trim()
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .toUpperCase();
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
  ) {
    if (!userId) return [];

    const approverRows = await prisma.workflowApprover.findMany({
      where: { reqTable, status: 'PENDING' },
      select: { reqId: true, approversList: true },
    });

    return approverRows
      .filter(
        (row) =>
          Array.isArray(row.approversList) &&
          row.approversList.includes(userId),
      )
      .map((row) => row.reqId);
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
    node: { nodePath: string },
  ) {
    const pendingRequests = await prisma.orgStructureReq.findMany({
      where: { companyId, status: 'PENDING' },
      select: {
        data: true,
        oldData: true,
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
        throw new AppError(
          'A parent or child organization node has a pending approval request',
          400,
        );
      }
    }
  }

  private static async getSubtreeNodes(
    client: any,
    companyId: string,
    nodePath: string,
  ) {
    return client.orgStructure.findMany({
      where: {
        companyId,
        OR: [{ nodePath }, { nodePath: { startsWith: `${nodePath}.` } }],
      },
      orderBy: { nodePath: 'asc' },
    });
  }

  private static async assertNoPrimaryAccessInSubtree(
    client: any,
    companyId: string,
    nodePath: string,
  ) {
    const nodes = await OrgStructureDbController.getSubtreeNodes(
      client,
      companyId,
      nodePath,
    );
    const primaryAccess = await client.userAccess.findFirst({
      where: {
        companyId,
        nodeId: { in: nodes.map((node: any) => node.id) },
        accessType: 'PRIMARY',
      },
    });

    if (primaryAccess) {
      throw new AppError(
        'Node cannot be made inactive while it or a child node has PRIMARY user access',
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

      const oldData = {
        status: node.status || 'ACTIVE',
      };
      const impact = 'INACTIVE';
      await OrgStructureDbController.assertNoPrimaryAccessInSubtree(
        prisma as any,
        companyId,
        node.nodePath,
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

      await NotificationService.createRequestNotification({
        companyId,
        type: 'INITIATE',
        referenceType: 'ORG',
        referenceId: request.id,
        referenceName: targetNodePath,
        createdBy: initiatorId,
        recipientUserIds: notificationRecipients,
      });
      res.status(201).json(request);
    } catch (error) {
      next(error);
    }
  }

  private static async applyApprovedModification(tx: any, request: any) {
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
    await tx.userAccess.deleteMany({
      where: { companyId: request.companyId, nodeId: { in: subtreeIds } },
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
            const directParentId = parentNodes.find(
              (n) => n.nodePath === directParentPath,
            )?.id;

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
                    directParentId
                      ? {
                          nodeId: directParentId,
                          accessCategory: 'IMMEDIATE_CHILD',
                        }
                      : undefined,
                  ].filter(Boolean) as any,
                },
              });

              // Prepare new entries, ensuring uniqueness
              const newAccessesMap = new Map();
              for (const access of parentAccesses) {
                const uniqueKey = `${access.userId}_${access.roleCode}`;
                if (!newAccessesMap.has(uniqueKey)) {
                  // Rule: IMMEDIATE_CHILD on parent becomes NODE on child
                  const newCategory =
                    access.accessCategory === 'IMMEDIATE_CHILD'
                      ? 'NODE'
                      : access.accessCategory;

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
        message = `Org structure request approved at Level ${result.level}, pending remaining approval`;
        notificationRecipients =
          await NotificationService.getCurrentApproverIds(
            id,
            'org_structure_req',
            notificationRecipients,
          );
      } else if (result && result.status === 'APPROVED') {
        message =
          result.type === 'UPDATE'
            ? 'Org structure modification approved'
            : 'Org structure request approved and node created';
      } else if (result && result.status === 'REJECTED') {
        message = 'Org structure request rejected';
      }

      if (notificationCompanyId) {
        const requestInitiatorId =
          await NotificationService.getRequestInitiatorId(
            id,
            'org_structure_req',
          );
        const notificationRecipientUserIds =
          NotificationService.mergeRecipientUserIds(
            notificationRecipients,
            requestInitiatorId,
          );

        await NotificationService.createRequestNotification({
          companyId: notificationCompanyId,
          type:
            result?.status === 'REJECTED'
              ? 'REJECT'
              : result?.status === 'APPROVED'
                ? 'ONBOARDED'
                : 'APPROVE',
          referenceType: 'ORG',
          referenceId: id,
          referenceName: notificationSubject,
          createdBy: approverId,
          recipientUserIds: notificationRecipientUserIds,
        });
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
        const reqRecord = await tx.orgStructureReq.create({
          data: {
            ...rest,
            initiatorId: initiatorId || null,
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
        recipientUserIds: notificationRecipients,
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

      if (nodeName || nodePath) {
        // 1. Resolve parent path if nodePath is likely the node's own path
        let parentPathForFilter = nodePath;
        let isRootSearch = false;

        if (nodePath) {
          const targetNode = await prisma.orgStructure.findFirst({
            where: {
              companyId: resolvedCompanyId,
              nodePath,
            },
            select: { nodeType: true },
          });

          if (targetNode?.nodeType === 'ROOT') {
            parentPathForFilter = undefined;
            isRootSearch = true;
          }
        }

        if (!isRootSearch && nodeName && nodePath) {
          const safeName = nodeName
            .trim()
            .replace(/[^a-zA-Z0-9_]/g, '_')
            .toUpperCase();
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
                : parentPathForFilter
                  ? {
                      data: {
                        path: ['parentNode', 'nodePath'],
                        equals: parentPathForFilter,
                      },
                    }
                  : {},
            ].filter((obj) => Object.keys(obj).length > 0) as any,
          },
          select: { id: true },
        });

        const reqIds = matchingReqs.map((r) => r.id);
        whereCondition.orgReqId = { in: reqIds };
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
                orgReqId: h.orgReqId,
                companyCode: h.company.companyCode,
                oldData:
                  h.orgReq?.oldData ||
                  ((h.orgReq?.data as any)?.oldData ?? null),
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
          orgReqId: h.orgReqId,
          companyCode: h.company.companyCode,
          oldData:
            h.orgReq?.oldData || ((h.orgReq?.data as any)?.oldData ?? null),
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
      const workflowIds = Array.from(
        new Set(pendingRequests.map((req) => req.workflowId).filter(Boolean)),
      ) as string[];
      const workflowDetails = await prisma.workflow.findMany({
        where: { id: { in: workflowIds } },
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
        ),
      );
      const pendingByNodePath = new Map<string, any>();
      pendingWithDetails.forEach((request: any) => {
        if (!approverRequestIds.has(request.id)) return;
        const requestData = request.data as any;
        const targetPath =
          requestData?.targetNodePath ||
          requestData?.nodePath ||
          requestData?.currentData?.nodePath;
        if (typeof targetPath === 'string' && !pendingByNodePath.has(targetPath)) {
          pendingByNodePath.set(targetPath, request);
        }
      });
      const visiblePendingWithDetails = pendingWithDetails.filter(
        (request: any) =>
          request.type === 'INITIATE' || approverRequestIds.has(request.id),
      );

      // 4. Remove internal UUIDs and format for the tree UI
      const safeNodes = nodes.map((node) => ({
        id: node.id,
        nodeId: node.id,
        nodeName: node.nodeName,
        nodeType: node.nodeType,
        nodePath: node.nodePath,
        pendingRequest: pendingByNodePath.has(node.nodePath)
          ? {
              id: pendingByNodePath.get(node.nodePath).id,
              type: pendingByNodePath.get(node.nodePath).type,
              status: pendingByNodePath.get(node.nodePath).status,
              oldData: pendingByNodePath.get(node.nodePath).oldData ?? null,
              newData: pendingByNodePath.get(node.nodePath).newData ?? null,
              createdAt: pendingByNodePath.get(node.nodePath).createdAt,
            }
          : null,
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
