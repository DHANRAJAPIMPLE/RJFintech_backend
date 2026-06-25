/**
 * AuthController:
 * Manages user authentication and session lifecycle.
 * Key responsibilities include:
 * - User registration with password hashing in the middle layer.
 * - User login with multi-device login detection and force-login logic.
 * - Session maintenance via refresh tokens and versioning.
 * - Secure logout by invalidating sessions in the backend.
 * - Providing current user profile information ('me' endpoint).
 * It uses internal fetch utilities to communicate with the backend auth services.
 */
import type { Request, Response, NextFunction } from 'express';
import requestIp from 'request-ip';
import { AppError } from '../../../shared/middlewares/error.middleware';
import { HashUtil } from '../../../shared/utils/hash.util';
import { formatUserGroups } from '../../utils/user-group.util';
import { bumpVersion, getExpiryDate } from '../../utils/auth.helper';
import { TokenUtil } from '../../utils/token.util';
import { config } from '../../config';
import { internalPost } from '../../utils/internal-fetch.util';
import { setAuthCookies, clearAuthCookies } from '../../utils/cookie.util';
import { zodParse } from '../../utils/zod-parse.util';
import {
  accessRightsSchema,
  registerSchema,
  loginSchema,
} from '../../validations/auth.validation';

import type {
  AuthAccessRightsRequest,
  AuthAccessRightsResponse,
  AuthApiErrorResponse,
  AuthBackendLoginUser,
  AuthBackendUser,
  AuthLoginApiResponse,
  AuthLoginResponse,
  AuthLogoutResponse,
  AuthMeResponse,
  AuthReporteeResponse,
  AuthUserGroup,
} from './auth.type';

export class AuthController {
  private static isGlobalUser(user: Pick<AuthBackendUser, 'userAccesses'>) {
    return (
      user.userAccesses?.some(
        (access) =>
          access.isGlobalAccess ||
          access.roleCode === 'SAAS_ADMIN' ||
          access.roleCode === 'CORP_ADMIN',
      ) ?? false
    );
  }

  private static getReporteeCountByCompanyId(
    managedUsers: Array<{ companyId: string }> = [],
  ) {
    return managedUsers.reduce<Record<string, number>>((acc, mapping) => {
      acc[mapping.companyId] = (acc[mapping.companyId] ?? 0) + 1;
      return acc;
    }, {});
  }

  static async register(req: Request, res: Response, next: NextFunction) {
    try {
      const validatedData = zodParse(registerSchema, { body: req.body });
      const { email, password, name, phone } = validatedData.body;

      // 1. Check if user already exists
      const existingUserRes = await internalPost<any>(
        `${config.backendAuthUrl}/get-user`,
        { email },
      );
      if (existingUserRes.status !== 404) {
        throw new AppError('User already exists', 400);
      }

      // 2. Hash password in Middle Layer
      const hashedPassword = await HashUtil.hash(password);

      // 3. Create user in Backend DB
      const createRes = await internalPost<any>(
        `${config.backendAuthUrl}/user/create`,
        {
          email,
          password: hashedPassword,
          name,
          phone,
        },
      );

      if (!createRes.ok) {
        throw new AppError('Registration failed', createRes.status);
      }

      // 4. Logic: Strip ID/Password from user object before sending to frontend
      const {
        id: _id,
        password: _password,
        ...userWithoutSensitiveData
      } = createRes.data;

      res.status(201).json({
        message: 'User registered successfully',
        user: userWithoutSensitiveData,
      });
    } catch (error) {
      next(error);
    }
  }

  static async login(
    req: Request,
    res: Response<AuthLoginApiResponse>,
    next: NextFunction,
  ) {
    try {
      const validatedData = zodParse(loginSchema, { body: req.body });
      const {
        email,
        password,
        action,
        forceLogToken: providedForceLogToken,
        companyCode: _companyCode,
      } = validatedData.body;
      const ip = requestIp.getClientIp(req) || 'unknown';
      const userAgent = req.headers['user-agent'] || 'unknown';

      // 1. Get user from Backend DB
      const userRes = await internalPost<AuthBackendLoginUser>(
        `${config.backendAuthUrl}/get-user`,
        { email },
      );
      const user = userRes.data;

      if (!userRes.ok || !user) {
        throw new AppError('Invalid credentials', 401);
      }

      const firstMapping = user.userMappings.find(
        (mapping) => mapping.status === 'ACTIVE',
      );
      if (!firstMapping) {
        throw new AppError('User is inactive or archived', 403);
      }

      const companyId = firstMapping.companyId;

      // 2. Validate password
      const isPasswordValid = await HashUtil.verify(user.password, password);
      if (!isPasswordValid) {
        throw new AppError('Invalid credentials', 401);
      }

      // 3. Get existing activity
      const activityRes = await internalPost<any>(
        `${config.backendAuthUrl}/get-user-activity`,
        { userId: user.id },
      );
      const existingActivity = activityRes.data;

      // 4. Apply business logic (force login, expiry, etc.)
      if (
        existingActivity &&
        existingActivity.expiryAt &&
        new Date(existingActivity.expiryAt) > new Date() &&
        existingActivity.refreshToken
      ) {
        if (action === 0) {
          const forceLogToken = HashUtil.generateRandomToken(64);
          const forceLogTokenHash = HashUtil.hashToken(forceLogToken);

          await internalPost(`${config.backendAuthUrl}/activity/upsert`, {
            userId: user.id,
            data: { forceLogToken: forceLogTokenHash },
          });

          return res.status(409).json({
            message: 'User already logged in another device',
            status: 1,
            forceLogToken,
          });
        }

        if (!providedForceLogToken) {
          throw new AppError('Force login token required', 400);
        }

        const providedTokenHash = HashUtil.hashToken(providedForceLogToken);
        if (
          !existingActivity.forceLogToken ||
          existingActivity.forceLogToken !== providedTokenHash
        ) {
          throw new AppError('Invalid force login token', 401);
        }
      }

      // 5. Prepare new session data
      const refreshToken = HashUtil.generateRandomToken(32);
      const refreshTokenHash = HashUtil.hashToken(refreshToken);

      const nextVersion = bumpVersion(existingActivity?.version);
      const versionHash = HashUtil.hashToken(nextVersion);

      const expiryAt = getExpiryDate(24);

      // 6. Update activity via backend
      await internalPost(`${config.backendAuthUrl}/activity/upsert`, {
        userId: user.id,
        data: {
          refreshToken: refreshTokenHash,
          version: nextVersion,
          companyId: companyId,
          ipAddress: ip,
          userAgent: userAgent,
          expiryAt: expiryAt,
          forceLogToken: null,
        },
      });

      // 7. Generate Access Token
      const accessToken = TokenUtil.generateAccessToken({
        userId: user.id,
        companyId: companyId,
      });

      // 8. Set Cookies
      setAuthCookies(res, {
        accessToken,
        refreshToken,
        versionHash,
      });

      res.locals.userId = user.id;
      res.locals.companyId = companyId;

      // 9. Response shaping
      const reporteeCountByCompanyId = AuthController.getReporteeCountByCompanyId(
        user.managedUsers,
      );
      const groups = formatUserGroups(
        user.userMappings,
        reporteeCountByCompanyId,
      ) as AuthUserGroup[];

      const response: AuthLoginResponse = {
        message: 'Login successful',
        user: {
          name: user.name,
          email: user.email,
          phone: user.phone,
          isGlobal: AuthController.isGlobalUser(user),
          groups,
        },
      };

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }

  static async refreshToken(req: Request, res: Response, next: NextFunction) {
    try {
      const accessTokenFromCookie =
        req.cookies?.accessToken || req.headers.authorization?.split(' ')[1];
      const refreshToken = req.cookies?.refreshToken;

      if (!refreshToken) {
        throw new AppError('Unauthorized - Refresh token missing', 401);
      }

      // 1. Resolve userId
      let userId = null;
      if (accessTokenFromCookie) {
        const decoded = TokenUtil.decodeToken(accessTokenFromCookie) as {
          userId: string;
        } | null;
        userId = decoded?.userId;
      }

      // 2. Fetch Activity
      let activityRes;
      const refreshTokenHash = HashUtil.hashToken(refreshToken);

      if (userId) {
        activityRes = await internalPost<any>(
          `${config.backendAuthUrl}/get-user-activity`,
          { userId },
        );
      } else {
        activityRes = await internalPost<any>(
          `${config.backendAuthUrl}/get-user-activity`,
          { refreshTokenHash },
        );
      }

      const activity = activityRes.data;

      // 3. Validate Activity
      if (!activity || !activity.refreshToken) {
        clearAuthCookies(res);
        throw new AppError('Unauthorized - Invalid session', 401);
      }

      const activeMapping = activity.user?.userMappings?.some(
        (mapping: any) =>
          mapping.companyId === activity.companyId &&
          mapping.status === 'ACTIVE',
      );
      if (!activeMapping) {
        clearAuthCookies(res);
        throw new AppError('Unauthorized - User is inactive or archived', 401);
      }

      if (activity.refreshToken !== refreshTokenHash) {
        clearAuthCookies(res);
        throw new AppError('User already logged in another device', 401);
      }

      if (activity.expiryAt && new Date(activity.expiryAt) < new Date()) {
        clearAuthCookies(res);
        throw new AppError('Unauthorized - Session expired', 401);
      }

      // 4. Generate New Tokens
      const nextVersion = bumpVersion(activity.version);
      const versionHash = HashUtil.hashToken(nextVersion);

      const newRefreshToken = HashUtil.generateRandomToken(32);
      const newRefreshTokenHash = HashUtil.hashToken(newRefreshToken);

      const expiryAt = getExpiryDate(24);

      // 5. Update Activity in Backend
      await internalPost(`${config.backendAuthUrl}/activity/upsert`, {
        userId: activity.userId,
        data: {
          refreshToken: newRefreshTokenHash,
          version: nextVersion,
          expiryAt: expiryAt,
        },
      });

      // 6. Generate New Access Token
      const newAccessToken = TokenUtil.generateAccessToken({
        userId: activity.userId,
        companyId: activity.companyId,
      });

      // 7. Set Cookies
      setAuthCookies(res, {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        versionHash,
      });

      res.locals.userId = activity.userId;
      res.locals.companyId = activity.companyId;

      res.status(200).json({ message: 'Token refreshed' });
    } catch (error) {
      next(error);
    }
  }

  static async me(
    req: Request & { user?: { id: string } },
    res: Response<AuthMeResponse>,
    next: NextFunction,
  ) {
    try {
      const userId = req.user?.id;

      if (!userId) {
        throw new AppError('Unauthorized', 401);
      }

      // 1. Fetch full user profile from Backend DB
      const {
        data: user,
        ok,
        status,
      } = await internalPost<AuthBackendUser>(
        `${config.backendAuthUrl}/get-user`,
        {
          userId,
        },
      );

      if (!ok || !user) {
        throw new AppError('Failed to fetch user data', status || 404);
      }

      // 2. Format User Groups in Middle Layer
      const reporteeCountByCompanyId = AuthController.getReporteeCountByCompanyId(
        user.managedUsers,
      );
      const groups = formatUserGroups(
        user.userMappings,
        reporteeCountByCompanyId,
      ) as AuthUserGroup[];

      res.locals.userId = user.id;
      res.locals.companyId = user.userMappings?.[0]?.companyId;

      const response: AuthMeResponse = {
        user: {
          name: user.name,
          email: user.email,
          phone: user.phone,
          isGlobal: AuthController.isGlobalUser(user),
          groups,
        },
      };

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }

  static async logout(
    req: Request,
    res: Response<AuthLogoutResponse>,
    next: NextFunction,
  ) {
    try {
      const refreshToken = req.cookies?.refreshToken;

      if (refreshToken) {
        // 1. Invalidate Activity in Backend DB
        const refreshTokenHash = HashUtil.hashToken(refreshToken);
        const backendRes = await internalPost<any>(
          `${config.backendAuthUrl}/activity/delete`,
          {
            refreshTokenHash,
          },
        );

        if (backendRes.ok && backendRes.data) {
          res.locals.userId = backendRes.data.userId;
          res.locals.companyId = backendRes.data.companyId;
        }
      }

      // 2. Clear Cookies in Middle Layer
      clearAuthCookies(res);

      const response: AuthLogoutResponse = {
        message: 'Logged out successfully',
      };

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }

  static async getAccessRights(
    req: Request<
      Record<string, never>,
      AuthAccessRightsResponse | AuthReporteeResponse,
      AuthAccessRightsRequest
    > & { user?: { id: string; companyId: string } },
    res: Response<AuthAccessRightsResponse | AuthReporteeResponse>,
    next: NextFunction,
  ) {
    try {
      const { email, companyCode, reportee } = zodParse(
        accessRightsSchema,
        req.body,
      );

      if (reportee) {
        const userId = req.user?.id;
        const companyId = req.user?.companyId;

        if (!userId || !companyId) {
          throw new AppError('Unauthorized', 401);
        }

        const backendRes = await internalPost<
          AuthReporteeResponse | AuthApiErrorResponse
        >(`${config.backendAuthUrl}/access-rights`, {
          reportee: true,
          userId,
          companyId,
        });

        if (!backendRes.ok) {
          const errorData = backendRes.data as AuthApiErrorResponse;
          throw new AppError(
            errorData?.message ||
              errorData?.error ||
              'Failed to fetch reportee users',
            backendRes.status || 500,
          );
        }

        return res.status(200).json(backendRes.data as AuthReporteeResponse);
      }

      const backendRes = await internalPost<
        AuthAccessRightsResponse | AuthApiErrorResponse
      >(`${config.backendAuthUrl}/access-rights`, {
        email,
        companyCode,
      });

      if (!backendRes.ok) {
        const errorData = backendRes.data as AuthApiErrorResponse;
        throw new AppError(
          errorData?.message ||
            errorData?.error ||
            'Failed to fetch access rights',
          backendRes.status || 500,
        );
      }

      res.status(200).json(backendRes.data as AuthAccessRightsResponse);
    } catch (error) {
      next(error);
    }
  }
}
