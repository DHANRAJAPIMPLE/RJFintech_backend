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
import { config } from '../../config';
import { internalPost } from '../../utils/internal-fetch.util';
import { zodParse } from '../../utils/zod-parse.util';
import {
  userOnboardingSchema,
  userActionSchema,
  userStatusUpdateSchema,
  userHistory,
  userCompanyNodesSchema,
  userFetchByNodePathCountSchema,
  userFilterOptionsSchema,
  userDetailsSchema,
  userListSchema,
  fetchAllUserSchema,
  userModificationSchema,
} from '../../validations/user.validation';
import type {
  ActionUserOnboardingInternalResponse,
  ActionUserOnboardingResponse,
  CreateUserOnboardingInternalResponse,
  FetchCompanyNodesInternalResponse,
  FetchCompanyNodesResponse,
  UserCompanyNode,
  FetchAllUsersResponse,
  FetchAndProcessUsersResult,
  FetchUserDetailsInternalResponse,
  FetchUserDetailsResponse,
  FetchUserFilterOptionsInternalResponse,
  FetchUserFilterOptionsResponse,
  FetchUsersByNodePathCountInternalResponse,
  FetchUsersByNodePathCountResponse,
  FetchUserHistoryInternalResponse,
  FetchUserHistoryInternalSuccess,
  FetchUserHistoryResponse,
  InitiateUserOnboardingResponse,
  PendingUserAccess,
  PendingUserListItem,
  UserApiErrorResponse,
  UserFilterNodeOption,
  UserFilterTextOption,
  UserHistoryInternalItem,
  UserHistoryItem,
  UserListAccess,
  UserListItem,
  UserOnboardingInternalResponse,
} from './user.type';

export class UserController {
  private static formatListAccess(access: UserListAccess): UserListAccess {
    return {
      roleCategory: access.roleCategory,
      roleSubCategory: access.roleSubCategory,
      roleName: access.roleName,
      nodeName: access.nodeName,
      nodePath: access.nodePath,
      nodeType: access.nodeType,
      accessCategory: access.accessCategory,
    };
  }

  private static formatPendingAccess(
    access: PendingUserAccess,
    options: { detail?: boolean } = {},
  ): PendingUserAccess {
    const detail = options.detail === true;
    return {
      roleCategory: access.roleCategory,
      roleSubCategory: access.roleSubCategory,
      roleName: access.roleName,
      nodeName: access.nodeName,
      nodePath: access.nodePath,
      ...(detail ? { nodeType: access.nodeType } : {}),
      accessCategory: access.accessCategory,
    };
  }

  private static formatUserListItem(
    user: UserListItem,
    options: { detail?: boolean } = {},
  ): UserListItem {
    const detail = options.detail === true;
    const primary = user.primary || [];
    return {
      isPending: user.isPending ?? false,
      basicDetails: {
        name: user.basicDetails.name,
        email: user.basicDetails.email,
        phone: user.basicDetails.phone,
        designation: user.basicDetails.designation,
        ...(!detail
          ? {
              nodeName:
                user.basicDetails.nodeName ?? primary[0]?.nodeName ?? null,
              nodePath:
                user.basicDetails.nodePath ?? primary[0]?.nodePath ?? null,
            }
          : {}),
        ...(detail && user.basicDetails.createdAt !== undefined
          ? { createdAt: user.basicDetails.createdAt }
          : {}),
        ...(detail && user.basicDetails.employeeId !== undefined
          ? { employeeId: user.basicDetails.employeeId }
          : {}),
        ...(detail && user.basicDetails.reportingManagerName !== undefined
          ? { reportingManagerName: user.basicDetails.reportingManagerName }
          : {}),
        ...(detail && user.basicDetails.reportingManagerEmail !== undefined
          ? { reportingManagerEmail: user.basicDetails.reportingManagerEmail }
          : {}),
      },
      ...(detail
        ? { primary: primary.map(UserController.formatListAccess) }
        : {}),
      ...(detail && user.secondary
        ? { secondary: user.secondary.map(UserController.formatListAccess) }
        : {}),
    };
  }

  private static formatPendingUserListItem(
    user: PendingUserListItem,
    options: { detail?: boolean } = {},
  ): PendingUserListItem {
    const isInitiate = user.type === 'INITIATE';
    const detail = options.detail === true;
    const primary = user.primary || [];
    return {
      id: user.id,
      type: user.type,
      impact: user.impact ?? null,
      ...(detail
        ? {
            oldData: isInitiate ? null : (user.oldData ?? null),
            newData: isInitiate ? null : (user.newData ?? null),
          }
        : {}),
      basicDetails: {
        name: user.basicDetails.name,
        email: user.basicDetails.email,
        phone: user.basicDetails.phone,
        designation: user.basicDetails.designation,
        ...(!detail
          ? {
              nodeName:
                user.basicDetails.nodeName ?? primary[0]?.nodeName ?? null,
              nodePath:
                user.basicDetails.nodePath ?? primary[0]?.nodePath ?? null,
            }
          : {}),
        ...(detail && user.basicDetails.createdAt !== undefined
          ? { createdAt: user.basicDetails.createdAt }
          : {}),
        ...(detail && user.basicDetails.employeeId !== undefined
          ? { employeeId: user.basicDetails.employeeId }
          : {}),
        ...(detail && user.basicDetails.status !== undefined
          ? { status: user.basicDetails.status }
          : {}),
        ...(detail && user.basicDetails.reportingManagerName !== undefined
          ? { reportingManagerName: user.basicDetails.reportingManagerName }
          : {}),
        ...(detail && user.basicDetails.reportingManagerEmail !== undefined
          ? { reportingManagerEmail: user.basicDetails.reportingManagerEmail }
          : {}),
        ...(detail && user.basicDetails.initiatorName !== undefined
          ? { initiatorName: user.basicDetails.initiatorName }
          : {}),
        ...(detail && user.basicDetails.initiatorEmail !== undefined
          ? { initiatorEmail: user.basicDetails.initiatorEmail }
          : {}),
        ...(detail && user.basicDetails.initiatedDate !== undefined
          ? { initiatedDate: user.basicDetails.initiatedDate }
          : {}),
        ...(detail && user.basicDetails.workflowName !== undefined
          ? { workflowName: user.basicDetails.workflowName }
          : {}),
        ...(detail && user.basicDetails.alias !== undefined
          ? { alias: user.basicDetails.alias }
          : {}),
      },
      ...(detail
        ? {
            primary: primary.map((access) =>
              UserController.formatPendingAccess(access, { detail: true }),
            ),
          }
        : {}),
      ...(detail && user.secondary
        ? {
            secondary: user.secondary.map((access) =>
              UserController.formatPendingAccess(access, { detail: true }),
            ),
          }
        : {}),
    };
  }

  private static formatTextOptions(
    options: UserFilterTextOption[],
  ): UserFilterTextOption[] {
    return options.map((option) => ({
      label: option.label,
      value: option.value,
    }));
  }

  private static formatNodeOptions(
    options: UserFilterNodeOption[],
  ): UserFilterNodeOption[] {
    return options.map((option) => ({
      label: option.label,
      value: option.value,
      nodeName: option.nodeName,
      nodePath: option.nodePath,
      nodeType: option.nodeType,
    }));
  }

  private static formatHistoryItem(
    item: UserHistoryInternalItem,
  ): UserHistoryItem {
    const result: UserHistoryItem = {
      id: item.id,
      email: item.email,
      event: item.event,
      levelCount: item.levelCount,
      createdAt: item.createdAt,
      remarks: item.remarks ?? null,
      user: {
        name: item.user.name,
        email: item.user.email,
      },
      changeCount: item.changeCount,
    };

    // Include level for APPROVED/REJECTED events
    if (item.level != null) {
      result.level = item.level;
    }

    // Include approvalSummary when present
    if (item.approvalSummary) {
      result.approvalSummary = item.approvalSummary;
    }

    // Include approvedBy when present and non-empty
    if (item.approvedBy && item.approvedBy.length > 0) {
      result.approvedBy = item.approvedBy.map((group) => ({
        level: group.level,
        rule: group.rule,
        approvedBy: group.approvedBy,
      }));
    }

    // Include eligibleapprovers when present
    if (item.eligibleapprovers && item.eligibleapprovers.length > 0) {
      result.eligibleapprovers = item.eligibleapprovers;
    }

    return result;
  }

  private static async fetchAndProcessUsers(
    req: Request & { user?: { id: string; companyId: string } },
    statusType?: 'active' | 'pending' | 'inactive' | 'archive',
  ): Promise<FetchAndProcessUsersResult> {
    const {
      direction,
      cursor: bodyCursor,
      prevCursor,
      nextCursor,
      cursorId,
      topCursor,
      offset,
      limit,
      page,
      query,
    } = zodParse(userListSchema, req.body ?? {});
    const companyId = req.user?.companyId;
    const userId = req.user?.id;
    if (!companyId || !userId) {
      throw new AppError('Unauthorized', 401);
    }
    const cursor =
      bodyCursor ??
      (direction === 'prev' ? prevCursor : nextCursor) ??
      cursorId ??
      null;
    const currentPage = page ?? Math.floor(offset / limit) + 1;
    const { data, ok, status } = await internalPost<any>(
      `${config.backendUrl}/internal/user/fetch-all`,
      {
        companyId,
        userId,
        statusType,
        direction,
        cursor,
        topCursor,
        offset,
        limit,
        page,
        query,
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
      archiveUsers = [],
      inactiveUsers = [],
      pendingUsers = [],
    } = data?.data || data || {};
    return {
      activeUsers: activeUsers.map(UserController.formatUserListItem),
      pendingUsers: pendingUsers.map((user: PendingUserListItem) =>
        UserController.formatPendingUserListItem(user),
      ),
      inactiveUsers: inactiveUsers.map(UserController.formatUserListItem),
      archiveUsers: archiveUsers.map(UserController.formatUserListItem),
      activeCount: data?.activeCount ?? activeUsers.length,
      archiveCount: data?.archiveCount ?? archiveUsers.length,
      inactiveCount: data?.inactiveCount ?? inactiveUsers.length,
      pendingCount: data?.pendingCount ?? pendingUsers.length,
      limit: data?.limit ?? limit,
      offset: data?.offset ?? offset,
      pageInfo: data?.pageInfo || {
        page: currentPage,
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

  static async fetchAllUsers(
    req: Request & { user?: { id: string; companyId: string } },
    res: Response<FetchAllUsersResponse>,
    next: NextFunction,
  ) {
    try {
      const { statusType } = zodParse(fetchAllUserSchema, req.body ?? {});
      const {
        activeUsers,
        archiveUsers,
        inactiveUsers,
        pendingUsers,
        activeCount,
        archiveCount,
        inactiveCount,
        pendingCount,
        pageInfo,
      } = await UserController.fetchAndProcessUsers(req, statusType);

      const response: FetchAllUsersResponse = {
        data:
          statusType === 'active'
            ? activeUsers
            : statusType === 'inactive'
              ? inactiveUsers
              : statusType === 'archive'
                ? archiveUsers
              : pendingUsers,
        activeCount,
        archiveCount,
        inactiveCount,
        pendingCount,
        pageInfo,
      };

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }

  static async fetchUserDetails(
    req: Request & { user?: { id: string; companyId: string } },
    res: Response<FetchUserDetailsResponse>,
    next: NextFunction,
  ) {
    try {
      const { id, email } = zodParse(userDetailsSchema, req.body ?? {});
      const companyId = req.user?.companyId;
      const userId = req.user?.id;

      if (!companyId || !userId) {
        throw new AppError('Unauthorized', 401);
      }

      const { data, ok, status } =
        await internalPost<FetchUserDetailsInternalResponse>(
          `${config.backendUrl}/internal/user/details`,
          {
            id,
            email,
            companyId,
            userId,
          },
        );

      if (!ok || !data?.data) {
        throw new AppError(
          data?.message || data?.error || 'Failed to fetch user details',
          status,
        );
      }

      const detail =
        'id' in data.data
          ? UserController.formatPendingUserListItem(
              data.data as PendingUserListItem,
              { detail: true },
            )
          : UserController.formatUserListItem(data.data as UserListItem, {
              detail: true,
            });

      res.status(200).json({
        message: 'User details fetched successfully!',
        code: 200,
        data: detail,
      });
    } catch (error) {
      next(error);
    }
  }

  static async fetchUserFilterOptions(
    req: Request & { user?: { companyId?: string } },
    res: Response<FetchUserFilterOptionsResponse>,
    next: NextFunction,
  ) {
    try {
      const companyId = req.user?.companyId;
      zodParse(userFilterOptionsSchema, req.body ?? {});

      if (!companyId) {
        throw new AppError('Unauthorized', 401);
      }

      const { data, ok, status } = await internalPost<
        FetchUserFilterOptionsInternalResponse | UserApiErrorResponse
      >(`${config.backendUrl}/internal/user/filter-option`, {
        companyId,
      });

      if (!ok) {
        const errorData = data as UserApiErrorResponse;
        throw new AppError(
          errorData?.message ||
            errorData?.error ||
            'Failed to fetch user filter options',
          status,
        );
      }

      const internalData = data as FetchUserFilterOptionsInternalResponse;
      const response: FetchUserFilterOptionsResponse = {
        message: 'User filter options fetched successfully!',
        code: 200,
        companyCode: internalData.companyCode,
        data: {
          designation: UserController.formatTextOptions(
            internalData.data.designation,
          ),
          department: UserController.formatNodeOptions(
            internalData.data.department,
          ),
          category: UserController.formatTextOptions(
            internalData.data.category,
          ),
          subCategory: UserController.formatTextOptions(
            internalData.data.subCategory,
          ),
          primaryNode: UserController.formatNodeOptions(
            internalData.data.primaryNode,
          ),
          secondaryNode: UserController.formatNodeOptions(
            internalData.data.secondaryNode,
          ),
          reportingManager: internalData.data.reportingManager.map(
            (manager) => ({
              label: manager.label,
              value: manager.value,
              name: manager.name,
              email: manager.email,
            }),
          ),
        },
      };

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }

  static async initiateUserOnboarding(
    req: Request & { user?: { id: string; companyId?: string } },
    res: Response<InitiateUserOnboardingResponse>,
    next: NextFunction,
  ) {
    try {
      const requestType =
        typeof req.body?.type === 'string'
          ? req.body.type.trim().toLowerCase()
          : 'initiate';

      if (requestType !== 'initiate') {
        const modification = zodParse(userModificationSchema, req.body);
        const initiatorId = req.user?.id;
        const companyId = req.user?.companyId;

        if (!initiatorId || !companyId) {
          throw new AppError('Unauthorized', 401);
        }

        const {
          data: createRes,
          ok: createOk,
          status: createStatus,
        } = await internalPost<CreateUserOnboardingInternalResponse>(
          `${config.backendUrl}/internal/user/create`,
          {
            initiatorId,
            companyId,
            type: modification.type.toUpperCase(),
            targetEmail: modification.targetUserEmail,
            levelsHash: modification.levelsHash || null,
            remarks: modification.remarks,
            data: {
              basicDetails: modification.basicDetails,
              permissions: modification.permissions,
            },
            status: 'PENDING',
          },
        );

        if (!createOk) {
          throw new AppError(
            createRes?.message ||
              createRes?.error ||
              'Failed to initiate user modification',
            createStatus,
          );
        }

        return res.status(201).json({
          message: 'User onboarding initiated successfully',
        });
      }

      const validatedData = zodParse(userOnboardingSchema, req.body);
      const initiatorId = req.user?.id;
      const companyId = req.user?.companyId;
      const { basicDetails, permissions, levelsHash } = validatedData;
      const { email, reportingManager } = basicDetails;

      if (!initiatorId || !companyId) {
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
        const managerInCompany = manager.userMappings?.some(
          (mapping: any) =>
            mapping.companyId === companyId && mapping.status === 'ACTIVE',
        );
        if (!managerInCompany) {
          throw new AppError(
            'Reporting manager is not active in your company',
            400,
          );
        }
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
      const { data: roles, ok: rolesOk } = await internalPost<any>(
        `${config.backendUrl}/internal/roles/fetch`,
        {
          permissions: permissions.map((permission) => ({
            roleName: permission.roleName,
            roleCategory: permission.roleCategory,
            roleSubCategory: permission.roleSubCategory,
          })),
        },
      );

      if (!rolesOk || !Array.isArray(roles)) {
        throw new AppError('Unable to validate roles', 400);
      }

      const roleLookup = new Set(
        roles.map(
          (role: any) =>
            `${role.roleName || ''}|${role.category || ''}|${role.subCategory || ''}`,
        ),
      );

      for (const permission of permissions) {
        const roleKey = `${permission.roleName}|${permission.roleCategory}|${permission.roleSubCategory}`;
        if (!roleLookup.has(roleKey)) {
          throw new AppError(`Role '${permission.roleName}' not found`, 400);
        }

        const { data: node, ok: nodeOk } = await internalPost<any>(
          `${config.backendUrl}/internal/org/get-node-by-path-companyid`,
          {
            nodePath: permission.nodePath,
            companyId,
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

      const { data: initiatorCompany, ok: initOk } = await internalPost<any>(
        `${config.backendUrl}/internal/company/get-by-id`,
        { id: companyId },
      );
      if (initOk && initiatorCompany) {
        companyCode = initiatorCompany.companyCode;
        const compMapping = initiatorCompany.companyMappings?.[0];
        if (compMapping && compMapping.group) {
          groupCode = compMapping.group.groupCode;
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
            companyId,
            companyCode,
            groupCode,
            type: 'INITIATE',
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
    req: Request & { user?: { id: string; companyId: string } },
    res: Response<ActionUserOnboardingResponse>,
    next: NextFunction,
  ) {
    try {
      const validatedData = zodParse(userActionSchema, req.body);
      const approverId = req.user?.id;
      const companyId = req.user?.companyId;
      const { id, action, remark } = validatedData;

      if (!approverId || !companyId) {
        throw new AppError('Unauthorized', 401);
      }

      // 1. Fetch onboarding record
      const { data: onboarding, ok: fetchOk } = await internalPost<
        UserOnboardingInternalResponse | UserApiErrorResponse | null
      >(`${config.backendUrl}/internal/user/get`, { id, companyId });

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
    req: Request & { user?: { id: string; companyId: string } },
    res: Response<FetchUserHistoryResponse>,
    next: NextFunction,
  ) {
    try {
      const { email } = zodParse(userHistory, req.body);
      const companyId = req.user?.companyId;
      const userId = req.user?.id;
      if (!companyId || !userId) {
        throw new AppError('Unauthorized', 401);
      }

      const { data, ok, status } =
        await internalPost<FetchUserHistoryInternalResponse>(
          `${config.backendUrl}/internal/user/history`,
          { email, companyId, userId },
        );

      if (!ok) {
        const errorData = data as UserApiErrorResponse;
        throw new AppError(
          errorData?.message || errorData?.error || 'User not found',
          status || 404,
        );
      }

      const historyData = data as FetchUserHistoryInternalSuccess;
      const response: FetchUserHistoryResponse = {
        message: historyData.message || 'User history fetched successfully!',
        code: historyData.code || 200,
        data: (historyData.data || []).map(UserController.formatHistoryItem),
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
      const nodes: UserCompanyNode[] = rawNodes.map((node) => ({
        nodeName: node.nodeName,
        nodePath: node.nodePath,
        nodeType: node.nodeType,
        status: node.status,
        workflows: node.workflows.map((workflow) => ({
          levelsHash: workflow.levelsHash,
          name: workflow.name,
          alias: workflow.alias,
          status: workflow.status,
        })),
        roleName: node.roleName || node.roleCode || '',
      }));

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
