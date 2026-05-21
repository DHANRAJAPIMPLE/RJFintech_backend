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
import { AppError } from '../../../shared/middlewares/error.middleware';
import { config } from '../../config';
import { internalPost } from '../../utils/internal-fetch.util';
import { zodParse } from '../../utils/zod-parse.util';
import { companyCodeOnly } from '../../validations/company.validation';
import {
  orgOnboardingSchema,
  orgOnboardingAction,
  orgHistory,
} from '../../validations/org.validation';
import type {
  InitiateOrgRequestResponse,
  OrgActionInternalResponse,
  FetchOrgHistoryInternalResponse,
  FetchOrgHistoryInternalSuccess,
  FetchOrgHistoryResponse,
  FetchOrgStructureInternalResponse,
  FetchOrgStructureInternalSuccess,
  FetchOrgStructureResponse,
  OrgApiErrorResponse,
  OrgCompanyLookupInternalResponse,
  OrgInitiateInternalResponse,
  OrgNodeInternal,
  OrgPendingInternalItem,
  OrgPendingItem,
  OrgRequestActionResponse,
  OrgStructureRequestInternal,
  OrgValidateInitiationInternalResponse,
} from './org.type';

export class OrgController {
  static async initiateOrgRequest(
    req: Request & { user?: { id: string } },
    res: Response<InitiateOrgRequestResponse>,
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
      const { data: company, ok: companyOk } =
        await internalPost<OrgCompanyLookupInternalResponse>(
          `${config.backendUrl}/internal/company/get-by-code`,
          { companyCode },
        );

      if (!companyOk || !company?.id) {
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

      const eligibleApprovers = [
        ...new Set([...(globalRes.data || []), ...(mgrRes.data || [])]),
      ];

      // 3. Validate Node Initiation (Check for duplicates and parent existence)
      const { data: validationRes, ok: validationOk } =
        await internalPost<OrgValidateInitiationInternalResponse>(
          `${config.backendUrl}/internal/org/validate-initiation`,
          {
            companyId: company.id,
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

      const { data, ok, status } =
        await internalPost<OrgInitiateInternalResponse>(
          `${config.backendUrl}/internal/org/initiate`,
          {
            initiatorId,
            companyId: company.id,
            levelsHash: levelsHash || null,
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
      });
    } catch (error) {
      next(error);
    }
  }

  static async approveOrgRequest(
    req: Request & { user?: { id: string } },
    res: Response<OrgRequestActionResponse>,
    next: NextFunction,
  ) {
    try {
      const { id, action, remark } = zodParse(orgOnboardingAction, req.body);
      const approverId = req.user?.id;

      if (!approverId) {
        throw new AppError('Unauthorized', 401);
      }

      // 1. Fetch request from Backend
      const { data: request, ok: fetchOk } = await internalPost<
        OrgStructureRequestInternal | OrgApiErrorResponse | null
      >(`${config.backendUrl}/internal/org/get-request`, { id });

      if (!fetchOk || !request || !('status' in request)) {
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
        const {
          data: rejectRes,
          ok: rejectOk,
          status: rejectStatus,
        } = await internalPost<OrgActionInternalResponse>(
          `${config.backendUrl}/internal/org/action`,
          {
            id,
            status: 'REJECTED',
            approverId,
            remarks: remark,
          },
        );

        if (!rejectOk) {
          throw new AppError(
            rejectRes?.message ||
              rejectRes?.error ||
              'Failed to reject org structure request',
            rejectStatus,
          );
        }

        return res
          .status(200)
          .json({ success: true, message: 'Org structure request rejected' });
      }

      // 4. Logic: Path Generation
      const { newNodeName, nodeType, parentNode } = request.data;

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
        const { data: parentNodeRecord } =
          await internalPost<OrgNodeInternal | null>(
            `${config.backendUrl}/internal/org/get-node`,
            {
              nodePath: parentPath,
            },
          );

        if (!parentNodeRecord) {
          throw new AppError('Parent node not found', 400);
        }
        parentId = parentNodeRecord.id;
      }

      // Check if path exists in Backend
      const { data: existingNode } = await internalPost<OrgNodeInternal | null>(
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
      } = await internalPost<OrgActionInternalResponse>(
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
      );

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
    res: Response<FetchOrgStructureResponse>,
    next: NextFunction,
  ) {
    try {
      const { companyCode } = zodParse(companyCodeOnly, req.body);
      const userId = req.user?.id;

      if (!userId) {
        throw new AppError('Unauthorized', 401);
      }

      // Forward to Backend (5001)
      const { data, ok, status } =
        await internalPost<FetchOrgStructureInternalResponse>(
          `${config.backendUrl}/internal/org/fetch`,
          { companyCode, userId },
        );

      if (!ok) {
        const errorData = data as OrgApiErrorResponse;
        throw new AppError(
          errorData?.message ||
            errorData?.error ||
            'Failed to fetch org structure',
          status,
        );
      }

      const orgData = data as FetchOrgStructureInternalSuccess;

      // Format response with active and pending arrays
      const formattedPending: OrgPendingItem[] = orgData.data.pending.map(
        (req: OrgPendingInternalItem) => {
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
        },
      );

      const response: FetchOrgStructureResponse = {
        message: 'Organization structure fetched successfully!',
        code: 200,
        data: {
          active: orgData.data.nodes,
          pending: formattedPending,
        },
      };

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }

  static async fetchOrgHistory(
    req: Request & { user?: { id: string } },
    res: Response<FetchOrgHistoryResponse>,
    next: NextFunction,
  ) {
    try {
      const { companyCode, nodeName, nodePath } = zodParse(
        orgHistory,
        req.body,
      );
      const userId = req.user?.id;

      if (!userId) {
        throw new AppError('Unauthorized', 401);
      }

      // Forward to Backend (5001)
      const { data, ok, status } =
        await internalPost<FetchOrgHistoryInternalResponse>(
          `${config.backendUrl}/internal/org/fetch-history`,
          { companyCode, nodeName, nodePath, userId },
        );

      if (!ok) {
        const errorData = data as OrgApiErrorResponse;
        throw new AppError(
          errorData?.message ||
            errorData?.error ||
            'Failed to fetch org structure history',
          status,
        );
      }

      const historyData = data as FetchOrgHistoryInternalSuccess;
      const response: FetchOrgHistoryResponse = {
        message:
          historyData.message ||
          'Organization structure history fetched successfully!',
        code: historyData.code || 200,
        data: historyData.data || [],
      };

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }
}
