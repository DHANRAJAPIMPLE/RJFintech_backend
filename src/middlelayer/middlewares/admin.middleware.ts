import type { Request, Response, NextFunction } from 'express';

import { AppError } from '../../shared/middlewares/error.middleware';

import { config } from '../config';
import { internalPost } from '../utils/internal-fetch.util';

/**
 * Admin Middleware:
 * This middleware restricts access to specific routes to only those users
 * who have the 'SAAS_ADMIN' role.
 *
 * Why we use it:
 * - To protect super-admin level operations (like system-wide configuration or global company management).
 * - It ensures a high level of security by verifying the user's role against the backend authority.
 */

export const adminMiddleware = async (
  req: Request & { user?: { id: string } },
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
