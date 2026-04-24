import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../shared/middlewares/error.middleware';
import { config } from '../config';
import { internalPost } from '../utils/internal-fetch.util';

export class UserController {
  static async fetchAllUsers(req: Request, res: Response, next: NextFunction) {
    try {
      // Logic: Forward request to Backend DB Service
      const { data, ok, status } = await internalPost(`${process.env.BACKEND_URL || 'http://localhost:5001'}/internal/user/fetch-all`);

      if (!ok) {
        throw new AppError(data.error || 'Failed to fetch users', status);
      }

      res.status(200).json(data);
    } catch (error) {
      next(error);
    }
  }
}
