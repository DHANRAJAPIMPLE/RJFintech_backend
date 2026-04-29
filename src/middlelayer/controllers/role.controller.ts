import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../shared/middlewares/error.middleware';
import { config } from '../config';
import { internalPost } from '../utils/internal-fetch.util';

export class RoleController {
  static async createRoles(
    req: Request & { user?: { id: string } },
    res: Response,
    next: NextFunction,
  ) {
    try {
      const rolesData = req.body;
      const userId = req.user?.id;

      if (!userId) {
        throw new AppError('Unauthorized', 401);
      }

      if (!Array.isArray(rolesData)) {
        throw new AppError(
          'Invalid data format. Expected an array of roles.',
          400,
        );
      }

      const results = [];
      for (const role of rolesData) {
        const { data, ok } = await internalPost(
          `${config.backendUrl}/internal/roles/upsert-role`,
          role,
        );
        if (ok) {
          results.push(data);
        }
      }

      res.status(200).json({
        success: true,
        data: results,
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
      const { data, ok, status } = await internalPost<any[]>(
        `${config.backendUrl}/internal/roles/fetch-all`,
      );

      if (!ok) {
        throw new AppError(data.message || 'Failed to fetch roles', status);
      }

      // 2. Logic: Apply formatting
      const formattedRoles = data.map((role) => ({
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
