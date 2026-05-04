import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../shared/middlewares/error.middleware';
import { internalPost } from '../utils/internal-fetch.util';
import { config } from '../config';
import type { AuthRequest } from './auth.middleware';

/**
 * Access Engine Middleware:
 * This middleware is used to enforce granular role-based access control (RBAC).
 * It validates if a user has the necessary permissions (view, modify, approve, initiate) 
 * for a specific functional module within a company.
 * 
 * Why we use it:
 * - To centralize permission checks.
 * - To ensure that users can only perform actions they are authorized for.
 * - It delegates the actual permission evaluation logic to the backend for consistency.
 *
 * Usage: router.post('/some-route', authorize('initiate', 'ORG_STR'), controller.method);
 */
export const authorize = (
  action: 'view' | 'modify' | 'approve' | 'initiate',
  module: string,
) => {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id;
      const companyId = req.user?.companyId;

      if (!userId || !companyId) {
        throw new AppError('Unauthorized: User information missing', 401);
      }

      // Fetch authorization status from the backend
      const response = await internalPost<{ authorized: boolean }>(
        `${config.backendAuthUrl}/get-user-access`,
        { userId, companyId, module, action },
      );

      if (!response.ok || !response.data) {
        throw new AppError('Failed to fetch user access permissions', 500);
      }

      if (response.data.authorized) {
        return next();
      }

      // If not authorized, return a 403 Forbidden error
      throw new AppError(
        `Access Denied: You do not have '${action}' permission for module '${module}'`,
        403,
      );
    } catch (error) {
      if (error instanceof AppError) {
        return next(error);
      }
      console.error('Authorization Error:', error);
      next(new AppError('Internal Server Error during authorization', 500));
    }
  };
};
