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
  workflowModificationSchema,
  workflowActionSchema,
  workflowHistorySchema,
  workflowListSchema,
  workflowDetailsSchema,
} from '../../validations/workflow.validation';
import type {
  FetchWorkflowHistoryInternalResponse,
  FetchWorkflowHistoryInternalSuccess,
  FetchWorkflowHistoryResponse,
  FetchWorkflowsInternalData,
  FetchWorkflowsInternalResponse,
  FetchWorkflowsResponse,
  WorkflowActiveInternalItem,
  InitiateWorkflowResponse,
  WorkflowActiveItem,
  WorkflowActionInternalResponse,
  WorkflowActionResponse,
  WorkflowApiErrorResponse,
  WorkflowCompanyLookupInternalResponse,
  WorkflowInitiateInternalResponse,
  WorkflowHistoryInternalItem,
  WorkflowHistoryItem,
  WorkflowNodeLookupInternalResponse,
  WorkflowPendingInternalItem,
  WorkflowPendingItem,
  WorkflowRequestInternal,
  WorkflowLinkedOrgStructureItem,
} from './workflow.type';

export class WorkflowController {
  private static formatLinkedOrgStructure(
    workflow: WorkflowLinkedOrgStructureItem,
  ): WorkflowLinkedOrgStructureItem {
    return {
      nodePath: workflow.nodePath,
      nodeName: workflow.nodeName,
      nodeType: workflow.nodeType,
    };
  }

  private static formatActiveWorkflow(
    workflow: WorkflowActiveItem | WorkflowActiveInternalItem,
    options: { detail?: boolean } = {},
  ): WorkflowActiveItem {
    const detail = options.detail === true;
    return {
      id: workflow.id,
      name: workflow.name,
      alias: workflow.alias,
      associateAlias: workflow.associateAlias ?? {
        workflowName: workflow.name ?? null,
        workflowAlias: workflow.alias ?? null,
      },
      workflowType:
        'type' in workflow ? workflow.type : (workflow.workflowType ?? 'NODE'),
      module: workflow.module,
      subModule: workflow.subModule,
      orgStructure: {
        nodePath: workflow.orgStructure.nodePath,
        nodeName: workflow.orgStructure.nodeName,
        nodeType: workflow.orgStructure.nodeType,
      },
      isPending: workflow.isPending ?? false,
      ...(detail
        ? {
            levelsHash: workflow.levelsHash,
            levels: (workflow.levels ?? []).map((level) => ({
              level: level.level,
              approver1: level.approver1,
              approver2: level.approver2,
              approverType: level.approverType,
            })),
            status: workflow.status ?? 'ACTIVE',
            linkedOrgStructure: (workflow.linkedOrgStructure ?? []).map(
              (child) => WorkflowController.formatLinkedOrgStructure(child),
            ),
          }
        : {}),
    };
  }

  private static formatPendingWorkflow(
    workflow: WorkflowPendingInternalItem,
    options: { detail?: boolean } = {},
  ): WorkflowPendingItem {
    const detail = options.detail === true;
    const nextData = workflow.newData as
      | { module?: string | null; subModule?: string | null }
      | null
      | undefined;
    return {
      id: workflow.id,
      workflowId: workflow.workflowId ?? null,
      type: workflow.type,
      impact: workflow.impact ?? null,
      status: workflow.status,
      alias: workflow.alias,
      module:
        workflow.module ?? workflow.data?.module ?? nextData?.module ?? null,
      subModule:
        workflow.subModule ??
        workflow.data?.subModule ??
        nextData?.subModule ??
        null,
      nodeType: workflow.nodeType,
      nodeName: workflow.nodeName,
      workflowName: workflow.workflowName,
      associateAlias: workflow.associateAlias ?? {
        workflowName: workflow.workflowName ?? null,
        workflowAlias: workflow.alias ?? null,
      },
      ...(detail
        ? {
            data: {
              name: workflow.data?.name,
              workflowType:
                workflow.data?.workflowType ?? workflow.workflowType ?? 'NODE',
              levels: workflow.data?.levels,
              module: workflow.data?.module,
              nodePath: workflow.data?.nodePath,
              subModule: workflow.data?.subModule,
              levelsHash:
                workflow.data?.levelsHash ?? workflow.levelsHash ?? null,
              status: workflow.data?.status ?? null,
            },
            oldData: workflow.oldData ?? workflow.data?.oldData ?? null,
            newData:
              workflow.type === 'INITIATE'
                ? null
                : (workflow.newData ?? workflow.data ?? null),
            approvalRemark: workflow.approvalRemark,
            levelsHash: workflow.levelsHash,
            createdAt: workflow.createdAt,
            initiator: {
              name: workflow.initiator?.name ?? '',
              email: workflow.initiator?.email ?? '',
            },
            initiatorTimestamp: workflow.initiatorTimestamp,
            nodePath: workflow.nodePath,
            linkedOrgStructure: (workflow.linkedOrgStructure ?? []).map(
              (child) => WorkflowController.formatLinkedOrgStructure(child),
            ),
          }
        : {}),
    };
  }

  private static formatHistoryItem(
    item: WorkflowHistoryInternalItem,
  ): WorkflowHistoryItem {
    const common = {
      id: item.id,
      workflowName: item.workflowName,
      changeCount: item.changeCount,
      levelCount: item.levelCount,
    };

    if ('eligibleapprovers' in item) {
      return {
        ...common,
        event: item.event,
        createdAt: null,
        eligibleapprovers: item.eligibleapprovers.map((approver) => ({
          name: approver.name,
          email: approver.email,
        })),
        ...(item.approvalSummary !== undefined
          ? { approvalSummary: item.approvalSummary }
          : {}),
        ...(item.approvedBy ? { approvedBy: item.approvedBy } : {}),
      };
    }

    return {
      ...common,
      event: item.event,
      createdAt: item.createdAt,
      remarks: item.remarks,
      linkedWorkflow: item.linkedWorkflow
        ? {
            workflowId: item.linkedWorkflow.workflowId ?? null,
            workflowName: item.linkedWorkflow.workflowName ?? null,
            nodeId: item.linkedWorkflow.nodeId ?? null,
            nodeName: item.linkedWorkflow.nodeName ?? null,
            nodePath: item.linkedWorkflow.nodePath ?? null,
          }
        : null,
      user: {
        name: item.user.name,
        email: item.user.email,
      },
      ...(item.level !== undefined ? { level: item.level } : {}),
      ...(item.approvalSummary !== undefined
        ? { approvalSummary: item.approvalSummary }
        : {}),
      ...(item.approvedBy ? { approvedBy: item.approvedBy } : {}),
    };
  }

  static async initiateWorkflow(
    req: Request & { user?: { id: string; companyId: string } },
    res: Response<InitiateWorkflowResponse>,
    next: NextFunction,
  ) {
    try {
      const initiatorId = req.user?.id;
      const companyId = req.user?.companyId;

      if (!initiatorId || !companyId) {
        throw new AppError('Unauthorized', 401);
      }

      const requestType =
        typeof req.body?.type === 'string'
          ? req.body.type.trim().toLowerCase()
          : 'initiate';
      const isModification =
        requestType === 'update' ||
        requestType === 'inactive' ||
        requestType === 'active' ||
        requestType === 'archive';
      const validatedData = isModification
        ? zodParse(workflowModificationSchema, req.body)
        : zodParse(workflowOnboardingSchema, req.body);

      if (isModification) {
        const modification = validatedData as ReturnType<
          typeof workflowModificationSchema.parse
        >;
        const {
          target,
          levelsHash,
          remarks,
          type: _type,
          ...requestData
        } = modification;
        const {
          data: createRes,
          ok: createOk,
          status: createStatus,
        } = await internalPost<WorkflowInitiateInternalResponse>(
          `${config.backendUrl}/internal/workflow/initiate`,
          {
            initiatorId,
            companyId,
            type: modification.type.toUpperCase(),
            target,
            levelsHash: levelsHash || null,
            remarks,
            data: requestData,
          },
        );

        if (!createOk) {
          throw new AppError(
            createRes?.message ||
              createRes?.error ||
              'Failed to initiate workflow modification request',
            createStatus,
          );
        }

        return res.status(201).json({
          message: 'Workflow modification request created successfully',
        });
      }

      const initiation = validatedData as ReturnType<
        typeof workflowOnboardingSchema.parse
      >;
      const {
        nodePath,
        levelsHash,
        type: _type,
        ...initiationData
      } = initiation;

      const { data: company, ok: companyOk } = await internalPost<
        WorkflowCompanyLookupInternalResponse | WorkflowApiErrorResponse | null
      >(`${config.backendUrl}/internal/company/get-by-id`, { id: companyId });
      if (!companyOk || !company || !('companyCode' in company)) {
        const errorData = company as WorkflowApiErrorResponse | null;
        throw new AppError(
          errorData?.message || errorData?.error || 'Company not found',
          404,
        );
      }
      const companyCode = company.companyCode;

      // 2. Check if Node Path exists
      const { data: node, ok: nodeOk } = await internalPost<
        WorkflowNodeLookupInternalResponse | WorkflowApiErrorResponse | null
      >(`${config.backendUrl}/internal/workflow/get-node-by-company`, {
        nodePath,
        companyId,
      });

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
      const eligibleApprovers = Array.from(
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
          companyId,
          levelsHash: levelsHash || null,
          type: 'INITIATE',
          data: initiationData,
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
      const companyId = req.user?.companyId;
      const { levelsHash, action, remark } = validatedData;

      if (!approverId || !companyId) {
        throw new AppError('Unauthorized', 401);
      }

      // 1. Fetch onboarding record
      const { data: onboarding, ok: fetchOk } = await internalPost<
        WorkflowRequestInternal | WorkflowApiErrorResponse | null
      >(`${config.backendUrl}/internal/workflow/get-request`, {
        levelsHash,
        companyId,
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
          companyId,
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

      const body = zodParse(workflowListSchema, req.body ?? {});
      const paginationBody = (body.pagination ?? {}) as Record<string, any>;
      const internalBody = {
        ...body,
        ...paginationBody,
        statusType: paginationBody.statusType ?? body.statusType,
        pagination: body.pagination,
      };
      const { data, ok, status } =
        await internalPost<FetchWorkflowsInternalResponse>(
          `${config.backendUrl}/internal/workflow/fetch`,
          { ...internalBody, companyId, userId: req.user?.id },
        );

      if (!ok) {
        const errorData = data as WorkflowApiErrorResponse;
        throw new AppError(
          errorData?.message || errorData?.error || 'Failed to fetch workflows',
          status,
        );
      }

      const workflowData = data as FetchWorkflowsInternalData;
      const publicData =
        internalBody.statusType === 'active' ||
        internalBody.statusType === 'inactive' ||
        internalBody.statusType === 'archive'
          ? workflowData.data.map((workflow) =>
              WorkflowController.formatActiveWorkflow(
                workflow as WorkflowActiveInternalItem,
              ),
            )
          : workflowData.data.map((workflow) =>
              WorkflowController.formatPendingWorkflow(
                workflow as WorkflowPendingInternalItem,
              ),
            );
      const response: FetchWorkflowsResponse = {
        message: 'Workflows fetched successfully!',
        code: 200,
        data: publicData,
        activeCount: workflowData.activeCount,
        pendingCount: workflowData.pendingCount,
        inactiveCount: workflowData.inactiveCount,
        archiveCount: workflowData.archiveCount,
        pageInfo: workflowData.pageInfo,
      };

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }

  static async fetchWorkflowDetails(
    req: Request & { user?: { id: string; companyId: string } },
    res: Response,
    next: NextFunction,
  ) {
    try {
      const body = zodParse(workflowDetailsSchema, req.body ?? {});
      const companyId = req.user?.companyId;

      if (!companyId) {
        throw new AppError('Unauthorized: Company information missing', 401);
      }

      const { data, ok, status } = await internalPost<any>(
        `${config.backendUrl}/internal/workflow/details`,
        {
          ...body,
          companyId,
          userId: req.user?.id,
        },
      );

      if (!ok || !data?.data) {
        throw new AppError(
          data?.message || data?.error || 'Failed to fetch workflow details',
          status,
        );
      }

      const detail =
        'workflowName' in data.data
          ? WorkflowController.formatPendingWorkflow(data.data, {
              detail: true,
            })
          : WorkflowController.formatActiveWorkflow(data.data, {
              detail: true,
            });

      res.status(200).json({
        message: 'Workflow details fetched successfully!',
        code: 200,
        data: detail,
      });
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
      const { id, levelsHash, module, subModule, nodePath } = zodParse(
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
            id,
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
          errorData?.message || errorData?.error || 'Failed to fetch history',
          status,
        );
      }

      const historyData = data as FetchWorkflowHistoryInternalSuccess;
      const response: FetchWorkflowHistoryResponse = {
        message:
          historyData.message || 'Workflow history fetched successfully!',
        code: historyData.code || 200,
        data: (historyData.data || []).map(
          WorkflowController.formatHistoryItem,
        ),
      };

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }
}
