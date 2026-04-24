import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../../lib/prisma';

export class OrgStructureDbController {
  static async initiateRequest(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { companyCode, newNodeName, nodeType, parentNode, initiatorId } =
        req.body;

      const company = await prisma.company.findUnique({
        where: { companyCode: companyCode },
      });

      if (!company) {
        return res
          .status(404)
          .json({ success: false, message: 'Company not found' });
      }

      const request = await prisma.orgStructureReq.create({
        data: {
          initiatorId,
          companyId: company.id,
          data: {
            newNodeName,
            nodeType,
            parentNode, // { nodeName, nodePath }
          },
          status: 'pending',
        },
      });

      res.status(201).json({
        success: true,
        message: 'Org structure request initiated',
        requestId: request.id,
      });
    } catch (error) {
      next(error);
    }
  }

  static async approveRequest(req: Request, res: Response, next: NextFunction) {
    try {
      const { requestId, approverId, remarks } = req.body;

      const request = await prisma.orgStructureReq.findUnique({
        where: { id: requestId },
        include: { company: true },
      });

      if (!request) {
        return res
          .status(404)
          .json({ success: false, message: 'Request not found' });
      }

      if (request.status !== 'pending') {
        return res
          .status(400)
          .json({ success: false, message: 'Request is already processed' });
      }

      const reqData = request.data as {
        newNodeName: string;
        nodeType: string;
        parentNode: { nodePath: string };
      };
      const { newNodeName, nodeType, parentNode } = reqData;

      let newNodePath = '';
      let parentId: string | null = null;

      if (nodeType === 'ROOT') {
        newNodePath = `${request.company.companyCode.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase()}.ROOT`;
      } else {
        const parentPath = parentNode.nodePath;
        const safeName = newNodeName
          .trim()
          .replace(/[^a-zA-Z0-9_]/g, '_')
          .toUpperCase();
        newNodePath = `${parentPath}.${safeName}`;

        const parentNodeRecord = await prisma.orgStructure.findUnique({
          where: { nodePath: parentPath },
        });

        if (!parentNodeRecord && nodeType !== 'ROOT') {
          return res
            .status(400)
            .json({ success: false, message: 'Parent node not found' });
        }
        parentId = parentNodeRecord?.id || null;
      }

      // Check if path already exists
      const existingNode = await prisma.orgStructure.findUnique({
        where: { nodePath: newNodePath },
      });

      if (existingNode) {
        return res
          .status(400)
          .json({ success: false, message: 'Node path already exists' });
      }

      // Transaction: Create node and update request
      await prisma.$transaction([
        prisma.orgStructure.create({
          data: {
            companyId: request.companyId,
            nodePath: newNodePath,
            nodeName: newNodeName,
            nodeType: nodeType,
            parentId: parentId,
          },
        }),
        prisma.orgStructureReq.update({
          where: { id: requestId },
          data: {
            status: 'approved',
            approverId,
            approvedAt: new Date(),
            remarks,
          },
        }),
      ]);

      res.status(200).json({
        success: true,
        message: 'Org structure request approved and node created',
        nodePath: newNodePath,
      });
    } catch (error) {
      next(error);
    }
  }

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

      const nodes = await prisma.orgStructure.findMany({
        where: { companyId: company.id },
        orderBy: { nodePath: 'asc' },
      });

      // Map to remove internal IDs and match user's desired format
      const safeNodes = nodes.map((node) => ({
        nodeName: node.nodeName,
        nodeType: node.nodeType,
        nodePath: node.nodePath,
      }));

      res.status(200).json({
        message: 'Organization structure fetched successfully!',
        code: 200,
        data: safeNodes,
      });
    } catch (error) {
      next(error);
    }
  }
}
