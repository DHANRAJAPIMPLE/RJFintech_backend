/**
 * WorkflowController:
 * Manages the initiation and approval process of various business workflows.
 * Key responsibilities:
 * - Initiating new workflow requests for specific organizational nodes.
 * - Validating company and node existence before initiation.
 * - Determining eligible approvers based on organizational hierarchy and roles.
 * - Processing workflow actions (approval/rejection) and updating request status.
 * - Fetching active workflows and pending requests for a company.
 * - Retrieving the history of actions taken on workflows.
 */
import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../../shared/middlewares/error.middleware';
import { config } from '../../config';
import { internalPost } from '../../utils/internal-fetch.util';
import { zodParse } from '../../utils/zod-parse.util';
import {
  workflowOnboardingSchema,
  workflowActionSchema,
  workflowHistorySchema,
} from '../../validations/workflow.validation';
import type {
  FetchWorkflowHistoryInternalResponse,
  FetchWorkflowHistoryResponse,
  FetchWorkflowsData,
  FetchWorkflowsInternalResponse,
  FetchWorkflowsResponse,
  InitiateWorkflowResponse,
  WorkflowActionInternalResponse,
  WorkflowActionResponse,
  WorkflowApiErrorResponse,
  WorkflowCompanyLookupInternalResponse,
  WorkflowInitiateInternalResponse,
  WorkflowNodeLookupInternalResponse,
  WorkflowRequestInternal,
} from './workflow.type';

export class WorkflowController {
  static async initiateWorkflow(
    req: Request & { user?: { id: string } },
    res: Response<InitiateWorkflowResponse>,
    next: NextFunction,
  ) {
    try {
      const validatedData = zodParse(workflowOnboardingSchema, req.body);
      const initiatorId = req.user?.id;
      const { companyCode, nodePath, levelsHash } = validatedData;

      if (!initiatorId) {
        throw new AppError('Unauthorized', 401);
      }

      // 1. Get Company ID from Backend
      const { data: company, ok: companyOk } = await internalPost<
        WorkflowCompanyLookupInternalResponse | WorkflowApiErrorResponse | null
      >(`${config.backendUrl}/internal/company/get-by-code`, { companyCode });

      if (!companyOk || !company || !('id' in company)) {
        const errorData = company as WorkflowApiErrorResponse | null;
        throw new AppError(
          errorData?.message || errorData?.error || 'Company not found',
          404,
        );
      }

      // 2. Check if Node Path exists
      const { data: node, ok: nodeOk } = await internalPost<
        WorkflowNodeLookupInternalResponse | WorkflowApiErrorResponse | null
      >(`${config.backendUrl}/internal/workflow/get-node`, { nodePath });

      if (!nodeOk || !node || !('id' in node)) {
        throw new AppError(`Node path '${nodePath}' not found`, 400);
      }

      // 3. Get eligible approver IDs (Global Access + Workflow Managers + SAAS_ADMIN)
      const [globalRes, mgrRes] = await Promise.all([
        internalPost<string[]>(
          `${config.backendUrl}/internal/onboarding/global-access-ids`,
          { companyCode },
        ),
        internalPost<string[]>(
          `${config.backendUrl}/internal/onboarding/approver-ids`,
          { companyCode, roleCode: 'WORK_FLOW_MGR' },
        ),
      ]);

      // Combine and deduplicate
      let eligibleApprovers = Array.from(
        new Set([...(globalRes.data || []), ...(mgrRes.data || [])]),
      );

      // 4. Initiate Workflow Request in Backend
      const {
        data: createRes,
        ok: createOk,
        status: createStatus,
      } = await internalPost<WorkflowInitiateInternalResponse>(
        `${config.backendUrl}/internal/workflow/initiate`,
        {
          initiatorId,
          companyId: company.id,
          levelsHash: levelsHash || null,
          data: validatedData,
          eligibleApprovers,
        },
      );

      if (!createOk) {
        throw new AppError(
          createRes?.message ||
            createRes?.error ||
            'Failed to initiate workflow request',
          createStatus,
        );
      }

      const response: InitiateWorkflowResponse = {
        message: 'Workflow initiation request created successfully',
      };

      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  }

  static async actionWorkflow(
    req: Request & { user?: { id: string; companyId: string } },
    res: Response<WorkflowActionResponse>,
    next: NextFunction,
  ) {
    try {
      const validatedData = zodParse(workflowActionSchema, req.body);
      const approverId = req.user?.id;
      const { levelsHash, action, remark } = validatedData;

      if (!approverId) {
        throw new AppError('Unauthorized', 401);
      }

      // 1. Fetch onboarding record
      const { data: onboarding, ok: fetchOk } = await internalPost<
        WorkflowRequestInternal | WorkflowApiErrorResponse | null
      >(`${config.backendUrl}/internal/workflow/get-request`, {
        levelsHash,
        companyId: req.user?.companyId,
      });

      if (!fetchOk || !onboarding || !('status' in onboarding)) {
        const errorData = onboarding as WorkflowApiErrorResponse | null;
        throw new AppError(
          errorData?.message ||
            errorData?.error ||
            'Workflow request not found',
          404,
        );
      }

      // 2. Validate status
      if (onboarding.status !== 'PENDING') {
        throw new AppError('Request already processed', 400);
      }

      // 3. Verify permissions (Disabled as per request)
      /*
      if (!onboarding.eligibleApprovers.includes(approverId)) {
        throw new AppError(
          'Unauthorized: You do not have permission to process this request',
          403,
        );
      }
      */

      // 4. Handle approval / rejection
      const {
        data: commitRes,
        ok: commitOk,
        status: commitStatus,
      } = await internalPost<WorkflowActionInternalResponse>(
        `${config.backendUrl}/internal/workflow/action`,
        {
          levelsHash,
          companyId: req.user?.companyId,
          approverId,
          remark,
          status: action,
        },
      );

      if (!commitOk) {
        throw new AppError(
          commitRes?.message ||
            commitRes?.error ||
            'Failed to process workflow action',
          commitStatus,
        );
      }

      const response: WorkflowActionResponse = {
        message:
          commitRes?.message || `Workflow request ${action}ed successfully`,
      };

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }

  static async fetchAllWorkflows(
    req: Request & { user?: { id: string; companyId: string } },
    res: Response<FetchWorkflowsResponse>,
    next: NextFunction,
  ) {
    try {
      const companyId = req.user?.companyId;

      if (!companyId) {
        throw new AppError('Unauthorized: Company information missing', 401);
      }

      const { data, ok, status } =
        await internalPost<FetchWorkflowsInternalResponse>(
          `${config.backendUrl}/internal/workflow/fetch`,
          { companyId, userId: req.user?.id },
        );

      if (!ok) {
        const errorData = data as WorkflowApiErrorResponse;
        throw new AppError(
          errorData?.message ||
            errorData?.error ||
            'Failed to fetch workflows',
          status,
        );
      }

      const workflowData = data as FetchWorkflowsData;
      const response: FetchWorkflowsResponse = {
        message: 'Workflows fetched successfully!',
        code: 200,
        data: workflowData,
      };

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }
  static async fetchWorkflowHistory(
    req: Request & { user?: { id: string; companyId: string } },
    res: Response<FetchWorkflowHistoryResponse>,
    next: NextFunction,
  ) {
    try {
      const { levelsHash, module, subModule, nodePath } = zodParse(
        workflowHistorySchema,
        req.body,
      );
      const companyId = req.user?.companyId;

      if (!companyId) {
        throw new AppError('Unauthorized: Company information missing', 401);
      }

      const { data, ok, status } =
        await internalPost<FetchWorkflowHistoryInternalResponse>(
          `${config.backendUrl}/internal/workflow/history`,
          {
            companyId,
            levelsHash,
            module,
            subModule,
            nodePath,
            userId: req.user?.id,
          },
        );

      if (!ok) {
        const errorData = data as WorkflowApiErrorResponse;
        throw new AppError(
          errorData?.message ||
            errorData?.error ||
            'Failed to fetch history',
          status,
        );
      }

      const historyData = data as FetchWorkflowHistoryResponse;
      const response: FetchWorkflowHistoryResponse = {
        message:
          historyData.message || 'Workflow history fetched successfully!',
        code: historyData.code || 200,
        data: historyData.data || [],
      };

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }
}
