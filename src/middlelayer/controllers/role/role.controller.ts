/**
 * RoleController:
 * Manages user roles and permissions within the system.
 * It provides functionality to:
 * - Create or update multiple roles (upsert) by communicating with the backend.
 * - Fetch a complete list of all available roles for assignment and management.
 * - Format role data for consistent presentation in the frontend.
 */
import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../../shared/middlewares/error.middleware';
import { config } from '../../config';
import { internalPost } from '../../utils/internal-fetch.util';
import { zodParse } from '../../utils/zod-parse.util';
import { roleUpsertSchema } from '../../validations/onboarding.validator';
import type {
  FetchAllRolesInternalResponse,
  FetchAllRolesItem,
  FetchAllRolesResponse,
  RoleApiErrorResponse,
} from './role.type';

export class RoleController {
  static async createRoles(
    req: Request & { user?: { id: string } },
    res: Response,
    next: NextFunction,
  ) {
    try {
      const userId = req.user?.id;

      if (!userId) {
        throw new AppError('Unauthorized', 401);
      }

      // Validate that the body is a non-empty array matching the role schema
      const rolesData = zodParse(roleUpsertSchema, req.body);

      const results = [];
      const errors: { role: any; error: string }[] = [];

      for (const role of rolesData) {
        const { data, ok, status } = await internalPost(
          `${config.backendUrl}/internal/roles/upsert-role`,
          role,
        );
        if (ok) {
          results.push(data);
        } else {
          errors.push({
            role,
            error:
              data?.message ||
              data?.error ||
              `Failed to upsert role (status ${status})`,
          });
        }
      }

      res.status(errors.length > 0 ? 207 : 200).json({
        success: errors.length === 0,
        data: results,
        ...(errors.length > 0 && { errors }),
      });
    } catch (error) {
      next(error);
    }
  }

  static async fetchAllRoles(
    req: Request & { user?: { id: string; companyId?: string } },
    res: Response<FetchAllRolesResponse>,
    next: NextFunction,
  ) {
    try {
      const userId = req.user?.id;

      if (!userId) {
        throw new AppError('Unauthorized', 401);
      }

      // 1. Fetch raw data from Backend
      const { data, ok, status } =
        await internalPost<FetchAllRolesInternalResponse>(
          `${config.backendUrl}/internal/roles/fetch-all`,
          { userId, companyId: req.user?.companyId },
        );

      if (!ok) {
        const errorData = data as RoleApiErrorResponse;
        throw new AppError(
          errorData?.message || errorData?.error || 'Failed to fetch roles',
          status,
        );
      }

      // 2. Logic: Apply formatting
      const roles = Array.isArray(data) ? data : [];
      const formattedRoles: FetchAllRolesItem[] = roles.map((role) => ({
        roleName: role.roleName,
        category: role.category,
        subCategory: role.subCategory,
        permissionLevel: role.permissionLevel,
      }));

      const response: FetchAllRolesResponse = {
        success: true,
        data: formattedRoles,
      };

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }
}
