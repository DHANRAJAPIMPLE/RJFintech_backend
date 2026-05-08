/**
 * OrgController:
 * Handles the management of the organizational hierarchy and node structures.
 * Features include:
 * - Initiating requests for new organizational nodes (ROOT, DEPARTMENT, etc.).
 * - Validating node initiation against existing structures.
 * - Approving or rejecting organizational structure changes.
 * - Generating unique node paths for hierarchical representation.
 * - Fetching active organizational structures and pending requests.
 * - Retrieving history of organizational changes.
 */
import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../shared/middlewares/error.middleware';
import { config } from '../config';
import { internalPost } from '../utils/internal-fetch.util';
import { zodParse } from '../utils/zod-parse.util';
import { companyCodeOnly } from '../validations/company.validation';
import {
  orgOnboardingSchema,
  orgOnboardingAction,
  orgHistory,
} from '../validations/org.validation';

export class OrgController {
  private static formatDate(date: Date | string | null): string {
    if (!date) return null;
    const d = new Date(date);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}-${month}-${year}`;
  }

  static async initiateOrgRequest(
    req: Request & { user?: { id: string } },
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { companyCode, newNodeName, nodeType, parentNode, workflowId } = zodParse(
        orgOnboardingSchema,
        req.body,
      );
      const initiatorId = req.user?.id;

      if (!initiatorId) {
        throw new AppError('Unauthorized', 401);
      }

      // 1. Get Company ID from Backend
      const { data: company, ok: companyOk } = await internalPost<any>(
        `${config.backendUrl}/internal/company/get-by-code`,
        { companyCode },
      );

      if (!companyOk || !company) {
        throw new AppError(
          company?.message || company?.error || 'Company not found',
          404,
        );
      }

      // 2. Logic: Get eligible approver IDs (Global Access + Org Structure Managers + SAAS_ADMIN)
      const [globalRes, mgrRes] = await Promise.all([
        internalPost<string[]>(
          `${config.backendUrl}/internal/onboarding/global-access-ids`,
          { companyCode },
        ),
        internalPost<string[]>(
          `${config.backendUrl}/internal/onboarding/approver-ids`,
          { companyCode, roleCode: 'ORG_STR_MGR' },
        ),
      ]);

      let eligibleApprovers = [
        ...new Set([
          ...(globalRes.data || []),
          ...(mgrRes.data || [])
        ]),
      ];

      // 3. Validate Node Initiation (Check for duplicates and parent existence)
      const { data: validationRes, ok: validationOk } = await internalPost<any>(
        `${config.backendUrl}/internal/org/validate-initiation`,
        {
          companyId: company?.id,
          newNodeName,
          nodeType,
          parentNode,
        },
      );

      if (!validationOk || !validationRes.success) {
        throw new AppError(
          validationRes?.message || 'Invalid organization structure request',
          400,
        );
      }

      // 4. Create request in Backend

      const { data, ok, status } = await internalPost(
        `${config.backendUrl}/internal/org/initiate`,
        {
          initiatorId,
          companyId: company?.id,
          workflowId: workflowId || null,
          data: {
            newNodeName,
            nodeType,
            parentNode,
          },
          status: 'PENDING',
          eligibleApprovers: eligibleApprovers,
        },
      );

      if (!ok) {
        throw new AppError(
          data?.message ||
          data?.error ||
          'Failed to initiate org structure request',
          status,
        );
      }

      res.status(201).json({
        success: true,
        message: 'Org structure request initiated',
        requestId: data.id,
      });
    } catch (error) {
      next(error);
    }
  }

  static async approveOrgRequest(
    req: Request & { user?: { id: string } },
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { id, action, remark } = zodParse(orgOnboardingAction, req.body);
      const approverId = req.user?.id;

      if (!approverId) {
        throw new AppError('Unauthorized', 401);
      }

      // 1. Fetch request from Backend
      const { data: request, ok: fetchOk } = await internalPost<any>(
        `${config.backendUrl}/internal/org/get-request`,
        { id },
      );

      if (!fetchOk || !request) {
        throw new AppError(
          request?.message ||
          request?.error ||
          'Org structure request not found',
          404,
        );
      }

      // 2. Logic: Verify status and permissions (Permission check disabled as per request)
      if (request.status !== 'PENDING') {
        throw new AppError('Request is already processed', 400);
      }

      /*
      if (!request.eligibleApprovers.includes(approverId)) {
        throw new AppError(
          'Unauthorized: You do not have permission to process this request',
          403,
        );
      }
      */

      // 3. Handle Rejection
      if (action === 'reject') {
        await internalPost(`${config.backendUrl}/internal/org/action`, {
          id,
          status: 'REJECTED',
          approverId,
          remarks: remark,
        });
        return res
          .status(200)
          .json({ success: true, message: 'Org structure request rejected' });
      }

      // 4. Logic: Path Generation
      const reqData = request.data as any;
      const { newNodeName, nodeType, parentNode } = reqData;

      let newNodePath = '';
      let parentId: string | null = null;

      if (nodeType === 'ROOT') {
        newNodePath = `${request.company.companyCode.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase()}`;
      } else {
        const parentPath = parentNode.nodePath;
        const safeName = newNodeName
          .trim()
          .replace(/[^a-zA-Z0-9_]/g, '_')
          .toUpperCase();
        newNodePath = `${parentPath}.${safeName}`;

        // Verify parent node in Backend
        const { data: parentNodeRecord } = await internalPost<any>(
          `${config.backendUrl}/internal/org/get-node`,
          { nodePath: parentPath },
        );

        if (!parentNodeRecord) {
          throw new AppError('Parent node not found', 400);
        }
        parentId = parentNodeRecord.id;
      }

      // Check if path exists in Backend
      const { data: existingNode } = await internalPost<any>(
        `${config.backendUrl}/internal/org/get-node`,
        { nodePath: newNodePath },
      );
      if (existingNode) {
        throw new AppError('Node path already exists', 400);
      }

      // 5. Commit Transaction in Backend
      const {
        data: commitRes,
        ok: commitOk,
        status: commitStatus,
      } = await internalPost(`${config.backendUrl}/internal/org/action`, {
        id,
        status: 'APPROVED',
        approverId,
        remarks: remark,
        newNodePath,
        newNodeName,
        nodeType,
        parentId,
      });

      if (!commitOk) {
        throw new AppError(
          commitRes?.message ||
          commitRes?.error ||
          'Failed to approve org structure request',
          commitStatus,
        );
      }

      res.status(200).json({
        success: true,
        message: 'Org structure request approved and node created',
        nodePath: newNodePath,
      });
    } catch (error) {
      next(error);
    }
  }

  static async fetchOrgStructure(
    req: Request & { user?: { id: string } },
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { companyCode } = zodParse(companyCodeOnly, req.body);
      const userId = req.user?.id;

      if (!userId) {
        throw new AppError('Unauthorized', 401);
      }

      // Forward to Backend (5001)
      const { data, ok, status } = await internalPost(
        `${config.backendUrl}/internal/org/fetch`,
        { companyCode, userId },
      );

      if (!ok) {
        throw new AppError(
          data?.message || data?.error || 'Failed to fetch org structure',
          status,
        );
      }

      // Format response with active and pending arrays
      const formattedPending = data.data.pending.map((req: any) => {
        const reqData = req.data || {};
        const initiatorHistory = req.orgHistories?.[0];
        return {
          id: req.id,
          newNodeName: reqData.newNodeName,
          nodeType: reqData.nodeType,
          parentNode: reqData.parentNode,
          initiatorName: initiatorHistory?.user?.name || null,
          initiatorEmail: initiatorHistory?.user?.email || null,
          initiatedDate: req.createdAt
        };
      });

      res.status(200).json({
        message: 'Organization structure fetched successfully!',
        code: 200,
        data: {
          active: data.data.nodes,
          pending: formattedPending,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  static async fetchOrgHistory(
    req: Request & { user?: { id: string } },
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { companyCode, nodeName } = zodParse(orgHistory, req.body);
      const userId = req.user?.id;

      // Forward to Backend (5001)
      const { data, ok, status } = await internalPost(
        `${config.backendUrl}/internal/org/fetch-history`,
        { companyCode, nodeName, userId },
      );

      if (!ok) {
        throw new AppError(
          data?.message ||
          data?.error ||
          'Failed to fetch org structure history',
          status,
        );
      }
      res.status(200).json({
        message:
          data && data.length > 0
            ? 'Organization structure history fetched successfully!'
            : 'Organization structure history not found',
        code: 200,
        data: data || [],
      });
    } catch (error) {
      next(error);
    }
  }
}
