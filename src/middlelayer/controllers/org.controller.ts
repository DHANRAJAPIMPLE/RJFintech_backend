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
import { internalPostOrThrow, internalPostOrThrowNotNull } from '../utils/internalPostOrThrow';
import { mergeEligibleApprovers } from '../utils/mergeEligibleApprovers';
import { zodParse } from '../utils/zod-parse.util';
import { companyCodeOnly } from '../validations/company.validation';
import {
  orgOnboardingSchema,
  orgOnboardingAction,
  orgHistory,
} from '../validations/org.validation';

export class OrgController {


  static async initiateOrgRequest(
    req: Request & { user?: { id: string } },
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { companyCode, newNodeName, nodeType, parentNode, levelsHash } =
        zodParse(orgOnboardingSchema, req.body);
      const initiatorId = req.user?.id;

      if (!initiatorId) {
        throw new AppError('Unauthorized', 401);
      }

      // 1. Get Company ID from Backend
      const company = await internalPostOrThrowNotNull<any>(
        `${config.backendUrl}/internal/company/get-by-code`,
        { companyCode },
        'Company not found',
        404,
      );

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

      let eligibleApprovers = mergeEligibleApprovers(globalRes.data, mgrRes.data);

      // 3. Validate Node Initiation (Check for duplicates and parent existence)
      const validationRes = await internalPostOrThrow<any>(
        `${config.backendUrl}/internal/org/validate-initiation`,
        {
          companyId: company?.id,
          newNodeName,
          nodeType,
          parentNode,
        },
        'Invalid organization structure request',
        400,
      );

      if (!validationRes.success) {
        throw new AppError(
          validationRes?.message || 'Invalid organization structure request',
          400,
        );
      }

      // 4. Create request in Backend

      const data = await internalPostOrThrow(
        `${config.backendUrl}/internal/org/initiate`,
        {
          initiatorId,
          companyId: company?.id,
          levelsHash: levelsHash || null,
          data: {
            newNodeName,
            nodeType,
            parentNode,
          },
          status: 'PENDING',
          eligibleApprovers: eligibleApprovers,
        },
        'Failed to initiate org structure request',
      );

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
      const request = await internalPostOrThrowNotNull<any>(
        `${config.backendUrl}/internal/org/get-request`,
        { id },
        'Org structure request not found',
        404,
      );

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
      const commitRes = await internalPostOrThrow(
        `${config.backendUrl}/internal/org/action`,
        {
          id,
          status: 'APPROVED',
          approverId,
          remarks: remark,
          newNodePath,
          newNodeName,
          nodeType,
          parentId,
        },
        'Failed to approve org structure request',
      );

      res.status(200).json({
        success: true,
        message:
          commitRes?.message ||
          'Org structure request approved and node created',
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
      const data = await internalPostOrThrow(
        `${config.backendUrl}/internal/org/fetch`,
        { companyCode, userId },
        'Failed to fetch org structure',
      );

      // Format response with active and pending arrays
      const formattedPending = data.data.pending.map((req: any) => {
        const reqData = req.data || {};
        return {
          id: req.id,
          newNodeName: reqData.newNodeName,
          nodeType: reqData.nodeType,
          parentNode: reqData.parentNode,
          initiatorName: req.initiator?.name || null,
          initiatorEmail: req.initiator?.email || null,
          initiatedDate: req.createdAt,
          workflowName: req.workflowName,
          alias: req.alias,
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
      const { companyCode, nodeName, nodePath } = zodParse(orgHistory, req.body);
      const userId = req.user?.id;

      // Forward to Backend (5001)
      const data = await internalPostOrThrow(
        `${config.backendUrl}/internal/org/fetch-history`,
        { companyCode, nodeName, nodePath, userId },
        'Failed to fetch org structure history',
      );

      res.status(200).json(data);
    } catch (error) {
      next(error);
    }
  }
}
