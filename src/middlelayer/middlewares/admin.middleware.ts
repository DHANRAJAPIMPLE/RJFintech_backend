import type { Request, Response, NextFunction } from 'express';

import { AppError } from '../../shared/middlewares/error.middleware';

import { config } from '../config';
import { internalPost } from '../utils/internal-fetch.util';

/**
 * AUTH MIDDLEWARE LOGIC:
 * Refactored to forward verification to the Backend Database Service (5001).
 */

export const adminMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      throw new AppError('User not found', 404);
    }

    const { data: user } = await internalPost<any>(
      `${config.backendAuthUrl}/get-role`,
      { userId },
    );

    if (user[0].roleCode !== 'SAAS_ADMIN') {
      throw new AppError('You are not authorized to perform this action', 403);
    }

    next();
  } catch (error) {
    if (error instanceof AppError) {
      return next(error);
    }
    next(new AppError('Unauthorized: Invalid session', 401));
  }
};
