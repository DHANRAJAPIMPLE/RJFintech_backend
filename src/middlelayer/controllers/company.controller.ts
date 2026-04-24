import type { Response, NextFunction } from 'express';
import type { AuthRequest } from '../middlewares/auth.middleware';
import { AppError } from '../../shared/middlewares/error.middleware';
import { config } from '../config';
import { internalPost } from '../utils/internal-fetch.util';

export class CompanyController {
  static async getMyCompanies(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user?.id;

      // Forward to Backend (5001)
      const { data, ok, status } = await internalPost(`${config.backendCompanyUrl}/my-companies`, { 
        userId 
      });

      if (!ok) {
        throw new AppError(data.error || 'Failed to fetch companies', status);
      }

      res.status(200).json(data);
    } catch (error) {
      next(error);
    }
  }

  static async getGroupCompanies(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      // Forward to Backend (5001)
      const { data, ok, status } = await internalPost(`${config.backendCompanyUrl}/groups`);

      if (!ok) {
        throw new AppError(data.error || 'Failed to fetch groups', status);
      }



      res.status(200).json(data);
    } catch (error) {
      next(error);
    }
  }
}
