/**
 * UserController:
 * Manages user-related operations and onboarding workflows.
 * Core functionalities:
 * - Fetching all users (active, pending, inactive) for a specific company.
 * - Initiating user onboarding with detailed basic info and permission sets.
 * - Validating reporting managers and existing user records across master and onboarding tables.
 * - Processing user onboarding actions (approve/reject).
 * - Toggling user active/inactive status.
 * - Retrieving user action history.
 * It coordinates between multiple backend endpoints to ensure data integrity and permission consistency.
 */
import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../../shared/middlewares/error.middleware';
import { getPagination } from '../../../shared/utils/pagination.util';
import { config } from '../../config';
import { internalPost } from '../../utils/internal-fetch.util';
import { zodParse } from '../../utils/zod-parse.util';
import { companyCodeOnly } from '../../validations/company.validation';
import {
  userOnboardingSchema,
  userActionSchema,
  userStatusUpdateSchema,
  userHistory,
  userCompanyNodesSchema,
  userFetchByNodePathCountSchema,
} from '../../validations/user.validation';
import type {
  ActionUserOnboardingInternalResponse,
  ActionUserOnboardingResponse,
  CreateUserOnboardingInternalResponse,
  FetchCompanyNodesInternalResponse,
  FetchCompanyNodesResponse,
  UserCompanyNode,
  FetchActiveUsersResponse,
  FetchAndProcessUsersResult,
  FetchPendingUsersResponse,
  FetchUsersByNodePathCountInternalResponse,
  FetchUsersByNodePathCountResponse,
  FetchUserHistoryInternalResponse,
  FetchUserHistoryResponse,
  InitiateUserOnboardingResponse,
  UserApiErrorResponse,
  UserOnboardingInternalResponse,
} from './user.type';

export class UserController {
  private static async fetchAndProcessUsers(
    req: Request,
    listType?: 'active' | 'pending',
  ): Promise<FetchAndProcessUsersResult> {
    const { companyCode } = zodParse(companyCodeOnly, {
      companyCode: req.body?.companyCode,
    });
    const { offset, limit } = getPagination(req.body);
    const rawPage = Number(req.body?.page);
    const page =
      Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
    const direction =
      typeof req.body?.direction === 'string' &&
      ['prev', 'previous'].includes(req.body.direction.trim().toLowerCase())
        ? 'prev'
        : 'next';
    const cursor =
      req.body?.cursor ??
      (direction === 'prev' ? req.body?.prevCursor : req.body?.nextCursor) ??
      req.body?.cursorId ??
      null;
    const topCursor = req.body?.topCursor || null;
    const { data, ok, status } = await internalPost<any>(
      `${config.backendUrl}/internal/user/fetch-all`,
      {
        companyCode,
        userId: (req as any).user?.id,
        listType,
        direction,
        cursor,
        topCursor,
        offset,
        limit,
        page: req.body?.page,
      },
    );
    if (!ok) {
      throw new AppError(
        data?.message || data?.error || 'Failed to fetch users',
        status,
      );
    }
    // Expected from backend: { data: { activeUsers: [], pendingUsers: [], inactiveUsers: [] } }
    const {
      activeUsers = [],
      inactiveUsers = [],
      pendingUsers = [],
    } = data?.data || data || {};
    return {
      activeUsers,
      pendingUsers,
      inactiveUsers,
      activeCount: data?.activeCount ?? activeUsers.length,
      inactiveCount: data?.inactiveCount ?? inactiveUsers.length,
      pendingCount: data?.pendingCount ?? pendingUsers.length,
      limit: data?.limit ?? limit,
      offset: data?.offset ?? offset,
      pageInfo: data?.pageInfo || {
        page,
        nextCursor: null,
        prevCursor: null,
        topCursor: null,
        hasNext: false,
        hasPrev: false,
        hasNewData: false,
        newCount: 0,
      },
    };
  }

  static async fetchActiveUsers(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const {
        activeUsers,
        activeCount,
        inactiveCount,
        pendingCount,
        pageInfo,
      } = await UserController.fetchAndProcessUsers(req, 'active');

      const response: FetchActiveUsersResponse = {
        data: activeUsers,
        activeCount,
        inactiveCount,
        pendingCount,
        pageInfo,
      };

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }

  static async fetchPendingUsers(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const {
        pendingUsers,
        activeCount,
        inactiveCount,
        pendingCount,
        pageInfo,
      } = await UserController.fetchAndProcessUsers(req, 'pending');

      const response: FetchPendingUsersResponse = {
        data: pendingUsers,
        activeCount,
        inactiveCount,
        pendingCount,
        pageInfo,
      };

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }

  static async fetchUserFilterOptions(
    req: Request & { user?: { companyId?: string } },
    res: Response,
    next: NextFunction,
  ) {
    try {
      const companyId = req.user?.companyId;
      const companyCode =
        typeof req.body?.companyCode === 'string'
          ? req.body.companyCode.trim()
          : undefined;

      if (!companyId && !companyCode) {
        throw new AppError('Company context is required', 400);
      }

      const { data, ok, status } = await internalPost<any>(
        `${config.backendUrl}/internal/user/filter-option`,
        {
          companyId,
          companyCode,
        },
      );

      if (!ok) {
        throw new AppError(
          data?.message || data?.error || 'Failed to fetch user filter options',
          status,
        );
      }

      res.status(200).json(data);
    } catch (error) {
      next(error);
    }
  }

  static async initiateUserOnboarding(
    req: Request & { user?: { id: string } },
    res: Response<InitiateUserOnboardingResponse>,
    next: NextFunction,
  ) {
    try {
      const validatedData = zodParse(userOnboardingSchema, req.body);
      const initiatorId = req.user?.id;
      const { basicDetails, permissions, levelsHash } = validatedData;
      const { email, reportingManager } = basicDetails;

      if (!initiatorId) {
        throw new AppError('Unauthorized', 401);
      }

      // 1. Logic: Validate reporting manager exists (if provided) and get their company info
      let manager: any = null;
      if (reportingManager) {
        const { data: m, ok: managerOk } = await internalPost<any>(
          `${config.backendUrl}/internal/onboarding/user/check-manager`,
          { email: reportingManager },
        );

        if (!managerOk || !m) {
          throw new AppError(
            m?.message || m?.error || 'Reporting manager email not found',
            400,
          );
        }
        manager = m;
      }

      // 2. Logic: Check if user already exists
      const { data: existingUser, ok: existsOk } = await internalPost<any>(
        `${config.backendUrl}/internal/onboarding/user/check-exists`,
        { email },
      );

      if (existsOk && existingUser) {
        throw new AppError('User already exists in master table', 400);
      }

      const { data: pendingUsers, ok: pendingOk } = await internalPost<any>(
        `${config.backendUrl}/internal/user/get-pending-users`,
        { email },
      );

      if (pendingOk && pendingUsers) {
        throw new AppError('User already exists in pending onboarding', 400);
      }

      // 3. Logic: Check if user exists as a signatory in pending company onboarding
      const { data: signatoryCheck, ok: signatoryCheckOk } =
        await internalPost<any>(
          `${config.backendUrl}/internal/company/check-signatories`,
          { emails: [email] },
        );

      if (signatoryCheckOk && signatoryCheck.exists) {
        throw new AppError(
          signatoryCheck.message ||
            'User already exists as a signatory in a pending company onboarding',
          400,
        );
      }

      // 4. Logic: Validate Permissions (Roles and Nodes)
      const targetCompanyId =
        manager?.userMappings?.[0]?.companyId || (req as any).user?.companyId;

      if (!targetCompanyId) {
        throw new AppError('Unable to determine target company', 400);
      }

      for (const permission of permissions) {
        const { data: roles, ok: rolesOk } = await internalPost<any>(
          `${config.backendUrl}/internal/roles/fetch`,
          {
            roleName: permission.roleName,
            roleCategory: permission.roleCategory,
            roleSubCategory: permission.roleSubCategory,
          },
        );

        if (!rolesOk || !Array.isArray(roles) || roles.length === 0) {
          throw new AppError(`Role '${permission.roleName}' not found`, 400);
        }

        const { data: node, ok: nodeOk } = await internalPost<any>(
          `${config.backendUrl}/internal/org/get-node-by-path-companyid`,
          {
            nodePath: permission.nodePath,
            companyId: targetCompanyId,
          },
        );

        if (!nodeOk || !node) {
          throw new AppError(`Node '${permission.nodePath}' not found`, 400);
        }
        if (node.nodeName !== permission.nodeName) {
          throw new AppError(
            `Node name '${permission.nodeName}' not found`,
            400,
          );
        }
      }

      // 5. Logic: Determine Company and Group Code
      let companyCode: string | undefined;
      let groupCode: string | undefined;

      if (manager) {
        const managerMapping = manager.userMappings?.[0];
        if (managerMapping && managerMapping.company) {
          companyCode = managerMapping.company.companyCode;
          const compMapping = managerMapping.company.companyMappings?.[0];
          if (compMapping && compMapping.group) {
            groupCode = compMapping.group.groupCode;
          }
        }
      } else {
        // Resolve from body companyId or initiator's session companyId
        const resolveId = req.body.companyId || (req as any).user?.companyId;

        if (resolveId) {
          const { data: initiatorCompany, ok: initOk } =
            await internalPost<any>(
              `${config.backendUrl}/internal/company/get-by-id`,
              { id: resolveId },
            );
          if (initOk && initiatorCompany) {
            companyCode = initiatorCompany.companyCode;
            const compMapping = initiatorCompany.companyMappings?.[0];
            if (compMapping && compMapping.group) {
              groupCode = compMapping.group.groupCode;
            }
          }
        }
      }

      if (!companyCode) {
        throw new AppError('Unable to resolve company code', 400);
      }

      // 6. Logic: Get eligible approver IDs (Global Access + User Access Managers + SAAS_ADMIN)
      const [globalRes, mgrRes] = await Promise.all([
        internalPost<string[]>(
          `${config.backendUrl}/internal/onboarding/global-access-ids`,
          { companyCode },
        ),
        internalPost<string[]>(
          `${config.backendUrl}/internal/onboarding/approver-ids`,
          { companyCode, roleCode: 'USER_ACC_MGR' },
        ),
      ]);

      // Combine and deduplicate
      const eligibleApprovers = Array.from(
        new Set([...(globalRes.data || []), ...(mgrRes.data || [])]),
      );

      // 7. Call Backend to create the record
      const {
        data: createRes,
        ok: createOk,
        status: createStatus,
      } = await internalPost<CreateUserOnboardingInternalResponse>(
        `${config.backendUrl}/internal/user/create`,
        {
          initiatorId,
          companyCode,
          groupCode,
          levelsHash: levelsHash || null,
          data: {
            basicDetails,
            permissions,
          },
          status: 'PENDING',
          eligibleApprovers: eligibleApprovers,
        },
      );

      if (!createOk) {
        throw new AppError(
          createRes?.message ||
            createRes?.error ||
            'Failed to initiate user onboarding',
          createStatus,
        );
      }

      const response: InitiateUserOnboardingResponse = {
        message: 'User onboarding initiated successfully',
      };

      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  }

  static async actionUserOnboarding(
    req: Request & { user?: { id: string } },
    res: Response<ActionUserOnboardingResponse>,
    next: NextFunction,
  ) {
    try {
      const validatedData = zodParse(userActionSchema, req.body);
      const approverId = req.user?.id;
      const { id, action, remark } = validatedData;

      if (!approverId) {
        throw new AppError('Unauthorized', 401);
      }

      // 1. Fetch onboarding record
      const { data: onboarding, ok: fetchOk } = await internalPost<
        UserOnboardingInternalResponse | UserApiErrorResponse | null
      >(`${config.backendUrl}/internal/user/get`, { id });

      if (!fetchOk || !onboarding || !('status' in onboarding)) {
        const errorData = onboarding as UserApiErrorResponse | null;
        throw new AppError(
          errorData?.message ||
            errorData?.error ||
            'User onboarding request not found',
          404,
        );
      }

      // 2. Logic: Validate status
      if (onboarding.status !== 'PENDING') {
        throw new AppError('Request already processed', 400);
      }

      // 3. Logic: Verify permissions (Disabled as per request)
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
      } = await internalPost<ActionUserOnboardingInternalResponse>(
        `${config.backendUrl}/internal/user/action`,
        {
          id,
          approverId,
          remark,
          status: action,
        },
      );

      if (!commitOk) {
        throw new AppError(
          commitRes?.message ||
            commitRes?.error ||
            'Failed to process user onboarding approval',
          commitStatus,
        );
      }

      const response: ActionUserOnboardingResponse = {
        message: commitRes?.message || 'User approved and onboarded',
      };

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }

  static async updateUserStatus(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { email } = zodParse(userStatusUpdateSchema, req.body);

      // 1. Fetch user by email
      const { data: user, ok } = await internalPost<any>(
        `${config.backendAuthUrl}/get-user`,
        { email },
      );

      if (!ok || !user) {
        throw new AppError(
          user?.message || user?.error || 'User not found',
          404,
        );
      }

      // 2. Determine target status (Toggle)
      const hasActive = user.userMappings.some(
        (m: any) => m.status === 'ACTIVE',
      );
      const targetStatus = hasActive ? 'INACTIVE' : 'ACTIVE';

      // 3. Update status in Backend
      const {
        data: updateData,
        ok: updateOk,
        status: updateStatus,
      } = await internalPost(
        `${config.backendUrl}/internal/user/update-status`,
        {
          userId: user.id,
          status: targetStatus,
        },
      );

      if (!updateOk) {
        throw new AppError(
          updateData?.message ||
            updateData?.error ||
            'Failed to update user status',
          updateStatus || 500,
        );
      }

      res.status(200).json({
        message: `User status changed to ${targetStatus}`,
        status: targetStatus,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getUserHistory(
    req: Request,
    res: Response<FetchUserHistoryResponse>,
    next: NextFunction,
  ) {
    try {
      const { email, companyCode } = zodParse(userHistory, req.body);

      const { data, ok, status } =
        await internalPost<FetchUserHistoryInternalResponse>(
          `${config.backendUrl}/internal/user/history`,
          { email, companyCode, userId: (req as any).user?.id },
        );

      if (!ok) {
        const errorData = data as UserApiErrorResponse;
        throw new AppError(
          errorData?.message || errorData?.error || 'User not found',
          status || 404,
        );
      }

      const historyData = data as FetchUserHistoryResponse;
      const response: FetchUserHistoryResponse = {
        message: historyData.message || 'User history fetched successfully!',
        code: historyData.code || 200,
        data: historyData.data || [],
      };

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }
  static async fetchCompanyNodes(
    req: Request & { user?: { id: string; companyId: string } },
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { subCategory } = zodParse(userCompanyNodesSchema, req.body);
      const userId = req.user?.id;
      const companyId = req.user?.companyId;

      if (!userId || !companyId) {
        throw new AppError('Unauthorized', 401);
      }

      const { data, ok, status } =
        await internalPost<FetchCompanyNodesInternalResponse>(
          `${config.backendUrl}/internal/user/fetch-company-nodes`,
          {
            userId,
            companyId,
            subCategory,
          },
        );
      const errorMessage = Array.isArray(data)
        ? undefined
        : data?.message || data?.error;

      if (!ok) {
        throw new AppError(
          errorMessage || 'Failed to fetch company nodes',
          status,
        );
      }

      const rawNodes = Array.isArray(data) ? data : data?.nodes || [];
      const nodes: UserCompanyNode[] = rawNodes.map(
        ({ roleCode, roleName, ...node }) => ({
          ...node,
          roleName: roleName || roleCode || '',
        }),
      );

      const response: FetchCompanyNodesResponse = {
        message:
          nodes.length > 0
            ? 'User nodes fetched successfully!'
            : 'User nodes not found',
        code: 200,
        data: nodes,
      };

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }

  static async fetchUsersByNodePathCount(
    req: Request & { user?: { id: string; companyId: string } },
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { nodePath } = zodParse(userFetchByNodePathCountSchema, req.body);
      const companyId = req.user?.companyId;

      const { data, ok, status } =
        await internalPost<FetchUsersByNodePathCountInternalResponse>(
          `${config.backendUrl}/internal/user/fetch-users-by-nodepath-count`,
          {
            nodePath,
            companyId,
          },
        );

      if (!ok) {
        throw new AppError(
          data?.message || data?.error || 'Failed to fetch user count',
          status,
        );
      }

      const response: FetchUsersByNodePathCountResponse = {
        message: 'User counts fetched successfully!',
        code: 200,
        data: data?.data || {},
      };

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }
}
