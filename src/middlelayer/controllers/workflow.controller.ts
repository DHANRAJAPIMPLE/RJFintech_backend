import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../shared/middlewares/error.middleware';
import { config } from '../config';
import { internalPost } from '../utils/internal-fetch.util';
import { zodParse } from '../utils/zod-parse.util';
import {
  workflowOnboardingSchema,
  workflowActionSchema,
  workflowHistorySchema,
  companyCodeOnlySchema,
} from '../validations/workflow.validation';

export class WorkflowController {
  private static formatDate(date: Date | string | null): string {
    if (!date) return 'N/A';
    const d = new Date(date);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}-${month}-${year}`;
  }

  static async initiateWorkflow(
    req: Request & { user?: { id: string } },
    res: Response,
    next: NextFunction,
  ) {
    try {
      const validatedData = zodParse(workflowOnboardingSchema, req.body);
      const initiatorId = req.user?.id;
      const { companyCode, name, alias, module, subModule, levels } =
        validatedData;

      if (!initiatorId) {
        throw new AppError('Unauthorized', 401);
      }

      // 1. Get Company ID
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

      // 2. Logic: Get eligible approver IDs (Global Access + Workflow Managers)
      const [globalRes, mgrRes] = await Promise.all([
        internalPost<string[]>(
          `${config.backendUrl}/internal/onboarding/global-access-ids`,
          { companyCode },
        ),
        internalPost<string[]>(
          `${config.backendUrl}/internal/onboarding/workflow-mgr-ids`,
          { companyCode },
        ),
      ]);

      const globalAccessIds = globalRes.data || [];
      const workflowMgrIds = mgrRes.data || [];

      // Combine and deduplicate
      const eligibleApprovers = Array.from(
        new Set([...globalAccessIds, ...workflowMgrIds]),
      );

      // 3. Create request in Backend
      const { data, ok, status } = await internalPost(
        `${config.backendUrl}/internal/workflow/initiate`,
        {
          initiatorId,
          companyId: company?.id,
          data: {
            companyCode,
            name,
            alias,
            module,
            subModule,
            levels,
          },
          status: 'PENDING',
          eligibleApprovers: eligibleApprovers,
        },
      );

      if (!ok) {
        throw new AppError(
          data?.message || data?.error || 'Failed to initiate workflow request',
          status,
        );
      }

      res.status(201).json({
        success: true,
        message: 'Workflow onboarding request initiated',
        requestId: data.id,
      });
    } catch (error) {
      next(error);
    }
  }

  static async approveWorkflowAction(
    req: Request & { user?: { id: string } },
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { id, action, remark } = zodParse(workflowActionSchema, req.body);
      const approverId = req.user?.id;

      if (!approverId) {
        throw new AppError('Unauthorized', 401);
      }

      const { data, ok, status } = await internalPost(
        `${config.backendUrl}/internal/workflow/action`,
        {
          id,
          action,
          approverId,
          remark,
        },
      );

      if (!ok) {
        throw new AppError(
          data?.message || data?.error || 'Failed to process workflow action',
          status,
        );
      }

      res.status(200).json({
        success: true,
        message: `Workflow request ${action}ed successfully`,
      });
    } catch (error) {
      next(error);
    }
  }

  static async fetchWorkflows(req: Request, res: Response, next: NextFunction) {
    try {
      const { companyCode } = zodParse(companyCodeOnlySchema, req.body);

      const { data, ok, status } = await internalPost<any>(
        `${config.backendUrl}/internal/workflow/fetch`,
        { companyCode },
      );

      if (!ok) {
        throw new AppError(
          data?.message || data?.error || 'Failed to fetch workflows',
          status,
        );
      }

      const formattedPending = (data.pendingRequests || []).map((req: any) => {
        const onbData = req.data || {};
        const initiatorHistory = req.workflowHistories?.find(
          (h: any) => h.event === 'INITIATE',
        );
        return {
          id: req.id,
          name: onbData.name,
          alias: onbData.alias,
          module: onbData.module,
          subModule: onbData.subModule,
          initiatorName: initiatorHistory?.user?.name || 'N/A',
          initiatorEmail: initiatorHistory?.user?.email || 'N/A',
          initiatedDate: WorkflowController.formatDate(req.createdAt),
          status: req.status,
        };
      });

      res.status(200).json({
        success: true,
        data: {
          active: data.workflows || [],
          pending: formattedPending,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  static async fetchWorkflowHistory(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { alias } = zodParse(workflowHistorySchema, req.body);

      const { data, ok, status } = await internalPost<any>(
        `${config.backendUrl}/internal/workflow/fetch-history`,
        { alias },
      );

      if (!ok) {
        throw new AppError(
          data?.message || data?.error || 'Failed to fetch workflow history',
          status,
        );
      }

      const formattedHistory = (data || []).map((h: any) => ({
        event: h.event,
        userName: h.user?.name || 'N/A',
        userEmail: h.user?.email || 'N/A',
        date: WorkflowController.formatDate(h.createdAt),
        remark: h.workflowReq?.approvalRemark || 'N/A',
      }));

      res.status(200).json({
        success: true,
        message:
          formattedHistory && formattedHistory.length > 0
            ? 'Workflow history fetched successfully!'
            : 'Workflow history not found',
        data: formattedHistory,
      });
    } catch (error) {
      next(error);
    }
  }
}
