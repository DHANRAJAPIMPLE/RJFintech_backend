import type { Request, Response, NextFunction } from 'express';
import { TokenUtil } from '../utils/token.util';
import { AppError } from '../../shared/middlewares/error.middleware';
import { mapAuthError } from '../utils/error-mapper.util';
import { config } from '../config';
import { internalPost } from '../utils/internal-fetch.util';
import { clearAuthCookies } from '../utils/cookie.util';
import { HashUtil } from '../../shared/utils/hash.util';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    name: string;
    email: string;
    phone: string;
    companyId: string;
  };
}

/**
 * AUTH MIDDLEWARE LOGIC:
 * Refactored to forward verification to the Backend Database Service (5001).
 */

export const authMiddleware = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const accessToken =
      req.cookies?.accessToken || req.headers.authorization?.split(' ')[1];
    const refreshToken = req.cookies?.refreshToken;
    const versionHashFromCookie = req.cookies?.versionHash;

    let userId: string | null = null;
    let companyId: string | null = null;
    let isExpired = false;

    // 1. Try to get userId and companyId from access token
    if (accessToken) {
      try {
        const decoded = TokenUtil.verifyAccessToken(accessToken) as {
          userId: string;
          companyId: string;
        };
        userId = decoded.userId;
        companyId = decoded.companyId;
      } catch (err: any) {
        if (err.name === 'TokenExpiredError') {
          isExpired = true;
          const decoded = TokenUtil.decodeToken(accessToken) as {
            userId: string;
            companyId: string;
          };
          userId = decoded?.userId || null;
          companyId = decoded?.companyId || null;
        }
      }
    }

    // 2. Consolidate Backend Call: Fetch activity exactly once
    let activity: any = null;
    let ok = false;

    if (userId) {
      // If we have a userId (from valid or expired token), fetch by ID
      const response = await internalPost<any>(
        `${config.backendAuthUrl}/get-user-activity`,
        { userId },
      );
      activity = response.data;
      ok = response.ok;
    } else if (refreshToken) {
      // If no access token but we have a refresh token, fetch by token hash
      const refreshTokenHash = HashUtil.hashToken(refreshToken);
      const response = await internalPost<any>(
        `${config.backendAuthUrl}/get-user-activity`,
        { refreshTokenHash },
      );
      activity = response.data;
      ok = response.ok;
    }

    // 3. Validation Logic
    if (!ok || !activity) {
      clearAuthCookies(res);
      throw new AppError(mapAuthError('Unauthorized - Session not found'), 401);
    }

    const dbVersionHash = activity.version
      ? HashUtil.hashToken(activity.version)
      : null;

    // A. Check for session validity (version and expiry)
    if (
      dbVersionHash !== versionHashFromCookie ||
      (activity.expiryAt && new Date(activity.expiryAt) < new Date())
    ) {
      clearAuthCookies(res);
      throw new AppError(
        mapAuthError('Unauthorized - Session changed or expired'),
        401,
      );
    }

    // B. Handle Token Refresh (if expired or if only refresh token was provided)
    if (isExpired || !accessToken) {
      if (!refreshToken) {
        clearAuthCookies(res);
        throw new AppError(
          mapAuthError('Unauthorized - No refresh token'),
          401,
        );
      }

      const refreshTokenHash = HashUtil.hashToken(refreshToken);
      if (activity.refreshToken !== refreshTokenHash) {
        clearAuthCookies(res);
        throw new AppError(mapAuthError('Unauthorized - Invalid session'), 401);
      }

      // Generate and set new access token
      const newAccessToken = TokenUtil.generateAccessToken({
        userId: activity.userId,
        companyId: activity.companyId,
      });
      res.cookie('accessToken', newAccessToken, {
        ...config.cookieOptions,
        maxAge: config.accessTokenMaxAge,
      });
      companyId = activity.companyId;
    }

    // 4. Company Access Control (for non-admin routes)
    // Admin routes are handled by adminMiddleware, but we ensure basic company matching here
    const isCompanyRoute = req.originalUrl.includes('/api/v1/company-settings');
    if (isCompanyRoute) {
      const requestedCompanyCode =
        req.body?.companyCode || req.query?.companyCode;

      if (requestedCompanyCode) {
        const belongsToCompany = activity.user?.userMappings?.some(
          (m: any) =>
            m?.company?.companyCode === requestedCompanyCode &&
            m?.companyId === companyId,
        );

        if (!belongsToCompany) {
          throw new AppError(
            'Unauthorized - You do not belong to this company',
            403,
          );
        }
      }
    }

    // 5. Finalize Request
    req.user = {
      ...activity.user,
      companyId: companyId,
    };
    next();
  } catch (error) {
    if (error instanceof AppError) {
      next(error);
    } else {
      clearAuthCookies(res);
      next(
        new AppError(mapAuthError('Unauthorized - Authentication failed'), 401),
      );
    }
  }
};
