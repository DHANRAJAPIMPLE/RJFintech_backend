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
import { AppError } from '../../shared/middlewares/error.middleware';
import { config } from '../config';
import { internalPost } from '../utils/internal-fetch.util';
import { internalPostOrThrow, internalPostOrThrowNotNull } from '../utils/internalPostOrThrow';
import { mergeEligibleApprovers } from '../utils/mergeEligibleApprovers';
import { zodParse } from '../utils/zod-parse.util';
import {
  workflowOnboardingSchema,
  workflowActionSchema,
  workflowHistorySchema,
} from '../validations/workflow.validation';

export class WorkflowController {
  static async initiateWorkflow(
    req: Request & { user?: { id: string } },
    res: Response,
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
      const company = await internalPostOrThrowNotNull<any>(
        `${config.backendUrl}/internal/company/get-by-code`,
        { companyCode },
        'Company not found',
        404,
      );

      // 2. Check if Node Path exists
      const { data: node, ok: nodeOk } = await internalPost<any>(
        `${config.backendUrl}/internal/workflow/get-node`,
        { nodePath },
      );

      if (!nodeOk || !node) {
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
      let eligibleApprovers = mergeEligibleApprovers(globalRes.data, mgrRes.data);

      // 4. Initiate Workflow Request in Backend
      const createRes = await internalPostOrThrow(
        `${config.backendUrl}/internal/workflow/initiate`,
        {
          initiatorId,
          companyId: company.id,
          levelsHash: levelsHash || null,
          data: validatedData,
          eligibleApprovers,
        },
        'Failed to initiate workflow request',
      );

      res.status(201).json({
        message: 'Workflow initiation request created successfully',
        data: createRes,
      });
    } catch (error) {
      next(error);
    }
  }

  static async actionWorkflow(
    req: Request & { user?: { id: string; companyId: string } },
    res: Response,
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
      const onboarding = await internalPostOrThrowNotNull<any>(
        `${config.backendUrl}/internal/workflow/get-request`,
        { levelsHash, companyId: req.user?.companyId },
        'Workflow request not found',
        404,
      );

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
      const commitRes = await internalPostOrThrow(
        `${config.backendUrl}/internal/workflow/action`,
        {
          levelsHash,
          companyId: req.user?.companyId,
          approverId,
          remark,
          status: action,
        },
        'Failed to process workflow action',
      );

      res
        .status(200)
        .json({
          message:
            commitRes?.message || `Workflow request ${action}ed successfully`,
        });
    } catch (error) {
      next(error);
    }
  }

  static async fetchAllWorkflows(
    req: Request & { user?: { id: string; companyId: string } },
    res: Response,
    next: NextFunction,
  ) {
    try {
      const companyId = req.user?.companyId;

      if (!companyId) {
        throw new AppError('Unauthorized: Company information missing', 401);
      }

      const data = await internalPostOrThrow<any>(
        `${config.backendUrl}/internal/workflow/fetch`,
        { companyId, userId: req.user?.id },
        'Failed to fetch workflows',
      );

      res.status(200).json({
        message: 'Workflows fetched successfully!',
        code: 200,
        data: data,
      });
    } catch (error) {
      next(error);
    }
  }
  static async fetchWorkflowHistory(
    req: Request & { user?: { id: string; companyId: string } },
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { levelsHash, module, subModule, nodePath } = zodParse(workflowHistorySchema, req.body);
      const companyId = req.user?.companyId;

      if (!companyId) {
        throw new AppError('Unauthorized: Company information missing', 401);
      }

      const data = await internalPostOrThrow<any>(
        `${config.backendUrl}/internal/workflow/history`,
        { companyId, levelsHash, module, subModule, nodePath, userId: req.user?.id },
        'Failed to fetch history',
      );

      res.status(200).json(data);
    } catch (error) {
      next(error);
    }
  }
}
