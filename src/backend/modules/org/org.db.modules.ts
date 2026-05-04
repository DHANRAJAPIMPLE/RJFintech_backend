import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../../lib/prisma';

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
    const node = await prisma.orgStructure.findUnique({
      where: { nodePath, companyId },
    });
    res.json(node);
  }

  // --- Transactional Commit Operations ---

  /**
   * Processes the approval or rejection of an organization unit request.
   * Logic:
   * - Uses a transaction to ensure that if a node is approved, the production record
   *   is created and the request status is updated simultaneously.
   * - Includes an 'eligibleApprovers' check to enforce authorization.
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

      const result = await prisma.$transaction(async (tx) => {
        const request = await tx.orgStructureReq.findUnique({
          where: { id },
          include: { company: true },
        });

        if (!request) throw new Error('Request not found');

        // Verify that the approver is authorized for this specific request
        if (
          request.eligibleApprovers &&
          request.eligibleApprovers.length > 0 &&
          !request.eligibleApprovers.includes(approverId)
        ) {
          throw new Error('Unauthorized to process this request');
        }

        // --- REJECT FLOW ---
        if (status.toUpperCase() === 'REJECTED') {
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
                companyCode: request.company.companyCode,
                event: 'REJECTED',
                eventUserId: approverId,
                orgReqId: id,
              },
            });
          }

          return updated;
        }

        // --- APPROVE FLOW ---
        if (status.toUpperCase() === 'APPROVED') {
          if (!newNodePath || !newNodeName || !nodeType) {
            throw new Error('Missing node details for approval');
          }

          // 1. Create the actual node in the production organization structure
          await tx.orgStructure.create({
            data: {
              companyId: request.companyId,
              nodePath: newNodePath,
              nodeName: newNodeName,
              nodeType: nodeType,
              parentId: parentId || null,
            },
          });

          // 2. Update the onboarding request status
          const updated = await tx.orgStructureReq.update({
            where: { id },
            data: {
              status: 'APPROVED',
              remarks,
            },
          });

          // 3. Log history for auditing
          await tx.orgHistory.create({
            data: {
              companyCode: request.company.companyCode,
              event: 'APPROVED',
              eventUserId: approverId,
              orgReqId: id,
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
   * Logs an 'INITIATE' event in the history for tracking.
   */
  static async initiateRequest(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { initiatorId, companyId, ...rest } = req.body;
      const request = await prisma.$transaction(async (tx) => {
        const reqRecord = await tx.orgStructureReq.create({
          data: {
            ...rest,
            companyId: companyId,
          },
          include: { company: true },
        });

        await tx.orgHistory.create({
          data: {
            companyCode: reqRecord.company.companyCode,
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
      const { companyId, newNodeName, _nodeType, parentNode } = req.body;

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
      const { companyCode } = req.body;

      const histories = await prisma.orgHistory.findMany({
        where: { companyCode },
        include: {
          user: { select: { name: true, email: true } },
          orgReq: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      // Format history for easy display
      const formattedHistories = histories.map((h) => ({
        companyCode: h.companyCode,
        event: h.event,
        createdAt: h.createdAt,
        user: h.user,
        newNodeName: (h.orgReq?.data as any)?.newNodeName || 'N/A',
      }));

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
      const { companyCode } = req.body;

      const company = await prisma.company.findUnique({
        where: { companyCode: companyCode },
      });

      if (!company) {
        return res
          .status(404)
          .json({ success: false, message: 'Company not found' });
      }

      // 1. Fetch active nodes in the hierarchy
      const nodes = await prisma.orgStructure.findMany({
        where: { companyId: company.id },
        orderBy: { nodePath: 'asc' },
      });

      // 2. Fetch pending requests for parallel tracking
      const pendingRequests = await prisma.orgStructureReq.findMany({
        where: {
          companyId: company.id,
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
