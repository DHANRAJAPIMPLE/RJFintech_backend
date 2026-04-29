import type { Request, Response, NextFunction } from 'express';
import requestIp from 'request-ip';
import { AppError } from '../../shared/middlewares/error.middleware';
import { HashUtil } from '../../shared/utils/hash.util';
import { formatUserGroups } from '../utils/user-group.util';
import { bumpVersion, getExpiryDate } from '../utils/auth.helper';
import { TokenUtil } from '../utils/token.util';
import { config } from '../config';
import { internalPost } from '../utils/internal-fetch.util';
import { setAuthCookies, clearAuthCookies } from '../utils/cookie.util';

export class AuthController {
  static async register(req: Request, res: Response, next: NextFunction) {
    try {
      const { email, password, name, phone } = req.body;

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
        id: _,
        password: _pw,
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

  static async login(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        email,
        password,
        action,
        forceLogToken: providedForceLogToken,
      } = req.body;
      const ip = requestIp.getClientIp(req) || 'unknown';
      const userAgent = req.headers['user-agent'] || 'unknown';

      // 1. Get user from Backend DB
      const userRes = await internalPost<any>(
        `${config.backendAuthUrl}/get-user`,
        { email },
      );
      const user = userRes.data;

      if (!userRes.ok || !user) {
        throw new AppError('Invalid credentials', 401);
      }

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
          ipAddress: ip,
          userAgent: userAgent,
          expiryAt: expiryAt,
          forceLogToken: null,
        },
      });

      // 7. Generate Access Token
      const accessToken = TokenUtil.generateAccessToken({ userId: user.id });

      // 8. Set Cookies
      setAuthCookies(res, {
        accessToken,
        refreshToken,
        versionHash,
      });

      // 9. Response shaping
      const groups = formatUserGroups(user.userMappings);

      res.status(200).json({
        message: 'Login successful',
        user: {
          name: user.name,
          email: user.email,
          phone: user.phone,
          groups,
        },
      });
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
      });

      // 7. Set Cookies
      setAuthCookies(res, {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        versionHash,
      });

      res.status(200).json({ message: 'Token refreshed' });
    } catch (error) {
      next(error);
    }
  }

  static async me(
    req: Request & { user?: { id: string } },
    res: Response,
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
      } = await internalPost<any>(`${config.backendAuthUrl}/get-user`, {
        userId,
      });

      if (!ok || !user) {
        throw new AppError('Failed to fetch user data', status || 404);
      }

      // 2. Format User Groups in Middle Layer
      const groups = formatUserGroups(user.userMappings);

      res.status(200).json({
        user: {
          name: user.name,
          email: user.email,
          phone: user.phone,
          groups,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  static async logout(req: Request, res: Response, next: NextFunction) {
    try {
      const refreshToken = req.cookies?.refreshToken;

      if (refreshToken) {
        // 1. Invalidate Activity in Backend DB
        const refreshTokenHash = HashUtil.hashToken(refreshToken);
        await internalPost(`${config.backendAuthUrl}/activity/delete`, {
          refreshTokenHash,
        });
      }

      // 2. Clear Cookies in Middle Layer
      clearAuthCookies(res);

      res.status(200).json({ message: 'Logged out successfully' });
    } catch (error) {
      next(error);
    }
  }
}
