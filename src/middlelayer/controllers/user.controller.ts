import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../shared/middlewares/error.middleware';
import { config } from '../config';
import { internalPost } from '../utils/internal-fetch.util';
import { zodParse } from '../utils/zod-parse.util';
import {
  userOnboardingSchema,
  userActionSchema,
  companyCodeOnly,
  userStatusUpdateSchema,
  userHistory,
} from '../validations/onboarding.validator';

export class UserController {
  private static formatDate(date: Date | null) {
    if (!date) return 'N/A';
    const d = new Date(date);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}-${month}-${year}`;
  }

  static async fetchAllUsers(req: Request, res: Response, next: NextFunction) {
    try {
      const { companyCode } = zodParse(companyCodeOnly, req.body);

      const { data, ok, status } = await internalPost<any>(
        `${config.backendUrl}/internal/user/fetch-all`,
        { companyCode },
      );

      if (!ok) {
        throw new AppError(
          data?.message || data?.error || 'Failed to fetch users',
          status,
        );
      }

      const { users, pendingOnboardings } = data;

      const result = {
        activeUsers: [] as any[],
        pendingUsers: [] as any[],
        inactiveUsers: [] as any[],
      };

      users.forEach((u: any) => {
        if (u.userMappings.length === 0) {
          const primaryRoles = u.userAccesses
            .filter((a: any) => a.accessType === 'PRIMARY')
            .map((a: any) => ({
              roleCategory: a.role?.category || 'N/A',
              roleSubCategory: a.role?.subCategory || 'N/A',
              roleName: a.role?.roleName || 'N/A',
              nodeName: a.orgStructure?.nodeName || 'N/A',
              nodePath: a.orgStructure?.nodePath || 'N/A',
              accessType: 'PRIMARY',
            }));

          const secondaryRoles = u.userAccesses
            .filter((a: any) => a.accessType === 'SECONDARY')
            .map((a: any) => ({
              roleCategory: a.role?.category || 'N/A',
              roleSubCategory: a.role?.subCategory || 'N/A',
              roleName: a.role?.roleName || 'N/A',
              nodeName: a.orgStructure?.nodeName || 'N/A',
              nodePath: a.orgStructure?.nodePath || 'N/A',
              accessType: 'SECONDARY',
            }));

          result.inactiveUsers.push({
            basicDetails: {
              name: u.name,
              email: u.email,
              phone: u.phone,
              createdAt: UserController.formatDate(u.createdAt),
              designation: 'N/A',
              reportingManager: 'N/A',
            },
            primary: primaryRoles,
            secondary: secondaryRoles,
          });
        } else {
          u.userMappings.forEach((m: any) => {
            const companyAccesses = u.userAccesses.filter(
              (a: any) => a.companyId === m.companyId,
            );

            const primaryRoles = companyAccesses
              .filter((a: any) => a.accessType === 'PRIMARY')
              .map((a: any) => ({
                roleCategory: a.role?.category || 'N/A',
                roleSubCategory: a.role?.subCategory || 'N/A',
                roleName: a.role?.roleName || 'N/A',
                nodeName: a.orgStructure?.nodeName || 'N/A',
                nodePath: a.orgStructure?.nodePath || 'N/A',
                accessType: 'PRIMARY',
              }));

            const secondaryRoles = companyAccesses
              .filter((a: any) => a.accessType === 'SECONDARY')
              .map((a: any) => ({
                roleCategory: a.role?.category || 'N/A',
                roleSubCategory: a.role?.subCategory || 'N/A',
                roleName: a.role?.roleName || 'N/A',
                nodeName: a.orgStructure?.nodeName || 'N/A',
                nodePath: a.orgStructure?.nodePath || 'N/A',
                accessType: 'SECONDARY',
              }));

            const userData = {
              basicDetails: {
                name: u.name,
                email: u.email,
                phone: u.phone,
                createdAt: UserController.formatDate(m.createdAt),
                designation: m.designation,
                reportingManager: m.manager?.email || 'N/A',
              },
              primary: primaryRoles,
              secondary: secondaryRoles,
            };

            if (m.status === 'ACTIVE') {
              result.activeUsers.push(userData);
            } else {
              result.inactiveUsers.push(userData);
            }
          });
        }
      });

      pendingOnboardings.forEach((onb: any) => {
        const onbData = onb.data as any;
        const basic = onbData?.basicDetails || {};
        const permissions = onbData?.permissions || [];

        const primary = permissions
          .filter((p: any) => p.accessType === 'PRIMARY')
          .map((p: any) => ({
            roleCategory: p.roleCategory || 'N/A',
            roleSubCategory: p.roleSubCategory || 'N/A',
            roleName: p.roleName || 'N/A',
            nodeName: p.nodeName || 'N/A',
            nodePath: p.nodePath || 'N/A',
            accessType: 'PRIMARY',
          }));

        const secondary = permissions
          .filter((p: any) => p.accessType === 'SECONDARY')
          .map((p: any) => ({
            roleCategory: p.roleCategory || 'N/A',
            roleSubCategory: p.roleSubCategory || 'N/A',
            roleName: p.roleName || 'N/A',
            nodeName: p.nodeName || 'N/A',
            nodePath: p.nodePath || 'N/A',
            accessType: 'SECONDARY',
          }));

        result.pendingUsers.push({
          id: onb.id,
          basicDetails: {
            name: basic.name || 'N/A',
            email: basic.email || 'N/A',
            phone: basic.phone || 'N/A',
            createdAt: UserController.formatDate(onb.createdAt),
            designation: basic.designation || 'N/A',
            reportingManager: basic.reportingManager || 'N/A',
            initiatorName: onb.initiator?.name || null,
            initiatorEmail: onb.initiator?.email || null,
            initiatedDate: onb.createdAt,
          },
          primary,
          secondary,
        });
      });

      res.status(200).json({
        message: 'Users fetched successfully!',
        code: 200,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async initiateUserOnboarding(
    req: Request & { user?: { id: string } },
    res: Response,
    next: NextFunction,
  ) {
    try {
      const validatedData = zodParse(userOnboardingSchema, req.body);
      const initiatorId = req.user?.id;
      const { basicDetails, permissions } = validatedData;
      const { email, reportingManager } = basicDetails;

      if (!initiatorId) {
        throw new AppError('Unauthorized', 401);
      }

      // 1. Logic: Validate reporting manager exists and get their company info
      const { data: manager, ok: managerOk } = await internalPost<any>(
        `${config.backendUrl}/internal/onboarding/user/check-manager`,
        { email: reportingManager },
      );

      if (!managerOk || !manager) {
        throw new AppError(
          manager?.message ||
            manager?.error ||
            'Reporting manager email not found',
          400,
        );
      }

      // 2. Logic: Check if user already exists
      const { data: existingUser } = await internalPost<any>(
        `${config.backendUrl}/internal/onboarding/user/check-exists`,
        { email },
      );
      if (existingUser) {
        throw new AppError('User already exists in master table', 400);
      }

      // 3. Logic: Determine Company and Group Code
      let companyCode: string | undefined;
      let groupCode: string | undefined;

      const managerMapping = manager.userMappings?.[0];
      if (managerMapping && managerMapping.company) {
        companyCode = managerMapping.company.companyCode;
        const compMapping = managerMapping.company.companyMappings?.[0];
        if (compMapping && compMapping.group) {
          groupCode = compMapping.group.groupCode;
        }
      }

      // Logic: Get global access user IDs
      const { data: globalAccessIds } = await internalPost<string[]>(
        `${config.backendUrl}/internal/onboarding/global-access-ids`,
        { companyCode },
      );

      // Call Backend to create the record
      const {
        data: createRes,
        ok: createOk,
        status: createStatus,
      } = await internalPost(`${config.backendUrl}/internal/user/create`, {
        initiatorId,
        companyCode,
        groupCode,
        data: {
          basicDetails,
          permissions,
        },
        status: 'PENDING',
        accessibleBy: globalAccessIds || [],
      });

      if (!createOk) {
        throw new AppError(
          createRes?.message ||
            createRes?.error ||
            'Failed to initiate user onboarding',
          createStatus,
        );
      }

      res
        .status(201)
        .json({ message: 'User onboarding initiated successfully' });
    } catch (error) {
      next(error);
    }
  }

  static async actionUserOnboarding(
    req: Request & { user?: { id: string } },
    res: Response,
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
      const { data: onboarding, ok: fetchOk } = await internalPost<any>(
        `${config.backendUrl}/internal/user/get`,
        { id },
      );

      if (!fetchOk || !onboarding) {
        throw new AppError(
          onboarding?.message ||
            onboarding?.error ||
            'User onboarding request not found',
          404,
        );
      }

      // 2. Logic: Validate status
      if (onboarding.status !== 'PENDING') {
        throw new AppError('Request already processed', 400);
      }

      // 3. Logic: Verify permissions
      if (!onboarding.accessibleBy.includes(approverId)) {
        throw new AppError(
          'Unauthorized: You do not have permission to process this request',
          403,
        );
      }

      // 4. Handle approval / rejection
      const {
        data: commitRes,
        ok: commitOk,
        status: commitStatus,
      } = await internalPost(`${config.backendUrl}/internal/user/action`, {
        id,
        approverId,
        remark,
        status: action,
      });

      if (!commitOk) {
        throw new AppError(
          commitRes?.message ||
            commitRes?.error ||
            'Failed to process user onboarding approval',
          commitStatus,
        );
      }

      res.status(200).json({ message: 'User approved and onboarded' });
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

  static async getUserHistory(req: Request, res: Response, next: NextFunction) {
    try {
      const { email, companyCode } = zodParse(userHistory, req.body);

      const { data, ok, status } = await internalPost<any>(
        `${config.backendUrl}/internal/user/history`,
        { email, companyCode },
      );

      if (!ok || !data) {
        throw new AppError(
          data?.message || data?.error || 'User not found',
          status || 404,
        );
      }

      res.status(200).json({
        message: 'User history fetched successfully!',
        code: 200,
        data,
      });
    } catch (error) {
      next(error);
    }
  }
}
