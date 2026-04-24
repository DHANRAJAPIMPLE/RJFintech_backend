import type { Response, NextFunction } from 'express';
import { AppError } from '../../shared/middlewares/error.middleware';
import { config } from '../config';
import { internalPost } from '../utils/internal-fetch.util';

export class RolesController {
  static async createRoles(req: any, res: Response, next: NextFunction) {
    try {
      const rolesData = req.body;
      const userId = req.user?.id;

      if (!userId) {
        throw new AppError('Unauthorized', 401);
      }

      // Forward to Backend (5001)
      const { data, ok, status } = await internalPost(`${config.backendUrl}/internal/roles/create`, rolesData);

      if (!ok) {
        throw new AppError(data.message || 'Failed to create roles', status);
      }

      res.status(200).json(data);
    } catch (error: any) {
      next(error);
    }
  }

  static async fetchAllRoles(req: any, res: Response, next: NextFunction) {
    try {
      const userId = req.user?.id;

      if (!userId) {
        throw new AppError('Unauthorized', 401);
      }

      // Forward to Backend (5001)
      const { data, ok, status } = await internalPost(`${config.backendUrl}/internal/roles/fetch-all`);

      if (!ok) {
        throw new AppError(data.message || 'Failed to fetch roles', status);
      }

      res.status(200).json(data);
    } catch (error: any) {
      next(error);
    }
  }
}
