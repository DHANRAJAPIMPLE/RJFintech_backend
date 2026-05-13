/**
 * RoleController:
 * Manages user roles and permissions within the system.
 * It provides functionality to:
 * - Create or update multiple roles (upsert) by communicating with the backend.
 * - Fetch a complete list of all available roles for assignment and management.
 * - Format role data for consistent presentation in the frontend.
 */
import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../shared/middlewares/error.middleware';
import { config } from '../config';
import { internalPost } from '../utils/internal-fetch.util';
import { zodParse } from '../utils/zod-parse.util';
import { roleUpsertSchema } from '../validations/onboarding.validator';

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
    req: Request & { user?: { id: string } },
    res: Response,
    next: NextFunction,
  ) {
    try {
      const userId = req.user?.id;

      if (!userId) {
        throw new AppError('Unauthorized', 401);
      }

      // 1. Fetch raw data from Backend
      const { data, ok, status } = await internalPost<any>(
        `${config.backendUrl}/internal/roles/fetch-all`,
      );

      if (!ok) {
        throw new AppError(
          data?.message || data?.error || 'Failed to fetch roles',
          status,
        );
      }

      // 2. Logic: Apply formatting
      const roles = Array.isArray(data) ? data : [];
      const formattedRoles = roles.map((role) => ({
        roleName: role.roleName,
        category: role.category,
        subCategory: role.subCategory,
        permissionLevel: role.permissionLevel,
      }));

      res.status(200).json({
        success: true,
        data: formattedRoles,
      });
    } catch (error) {
      next(error);
    }
  }
}
