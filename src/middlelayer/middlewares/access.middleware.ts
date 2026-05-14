import type { Response, NextFunction } from 'express';
import { AppError } from '../../shared/middlewares/error.middleware';
import { internalPost } from '../utils/internal-fetch.util';
import { config } from '../config';
import type { AuthRequest } from './auth.middleware';

const normalizeNodeIdentifier = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }

  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const node = value as Record<string, unknown>;
  return normalizeNodeIdentifier(node.nodePath);
};

const getTargetNode = (body: any): string | undefined => {
  const data = body?.data;
  const candidates = [
    body?.nodePath,
    body?.parentNode,
    body?.node,
    data?.nodePath,
    data?.parentNode,
    data?.node,
  ];

  for (const candidate of candidates) {
    const identifier = normalizeNodeIdentifier(candidate);
    if (identifier) {
      return identifier;
    }
  }

  return undefined;
};

/**
 * Access Engine Middleware:
 * This middleware is used to enforce granular role-based access control (RBAC).
 * It validates if a user has the necessary permissions (view, modify, approve, initiate)
 * for a specific functional module within a company.
 *
 * Why we implement this:
 * - Centralized Security: Instead of writing 'if' checks in every controller, we use this middleware.
 * - Context Awareness: It automatically detects the module and target node from the request body,
 *   making it highly flexible across different features (Users, Org Structure, Workflows).
 * - Backend Delegation: It sends the request context to the backend, ensuring that complex
 *   hierarchy logic is evaluated in a single source of truth.
 *
 * Logic:
 * 1. Identifies the user and company from the JWT (via AuthRequest).
 * 2. Dynamically extracts the module name and target node identifier from the request body.
 * 3. For 'initiate' actions, it passes the entire request body to the backend to allow for
 *    deep inspection of multi-node operations (like assigning multiple user permissions).
 *
 * Usage: router.post('/some-route', authorize('initiate', 'ORG_STR'), controller.method);
 */
export const authorize = (
  action: 'view' | 'modify' | 'approve' | 'initiate',
  moduleName?: string,
) => {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id;
      const companyId = req.user?.companyId;

      // Determine the module: use the provided moduleName or fallback to req.body fields
      const module =
        moduleName ||
        req.body?.subCategory ||
        req.body?.subModule ||
        req.body?.module;

      // Extract node context if available. Initiate requests also send the
      // full body so the backend can inspect nested org/workflow/user nodes.
      const targetNode = getTargetNode(req.body);

      if (!userId || !companyId) {
        throw new AppError('Unauthorized: User information missing', 401);
      }

      if (!module) {
        throw new AppError('Authorization Denied: Module context missing', 400);
      }

      // Fetch authorization status from the backend
      const response = await internalPost<{ authorized: boolean }>(
        `${config.backendAuthUrl}/get-user-access`,
        {
          userId,
          companyId,
          module,
          action,
          targetNode,
          body: action === 'initiate' ? req.body : undefined,
        },
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

/**
 * Global User Check:
 * Specialized middleware to verify if the requester has global access permissions.
 */
export const checkGlobalUser = () => {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id;
      const companyId = req.user?.companyId;

      if (!userId || !companyId) {
        throw new AppError('Unauthorized: User information missing', 401);
      }

      // Check for global access status via backend
      const response = await internalPost<{ isGlobal: boolean }>(
        `${config.backendUrl}/internal/user/check-global`,
        { userId, companyId },
      );

      if (!response.ok || !response.data) {
        throw new AppError('Failed to verify global user status', 500);
      }

      if (response.data.isGlobal) {
        return next();
      }

      throw new AppError(
        'Access Denied: Only users with global access can initiate this action',
        403,
      );
    } catch (error) {
      next(error);
    }
  };
};
