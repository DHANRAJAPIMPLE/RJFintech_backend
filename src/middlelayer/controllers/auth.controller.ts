import type { Request, Response, NextFunction } from 'express';
import requestIp from 'request-ip';
import { AppError } from '../../shared/middlewares/error.middleware';
import { mapAuthError } from '../utils/error-mapper.util';
import { TokenUtil } from '../utils/token.util';
import { config } from '../config';
import { internalPost } from '../utils/internal-fetch.util';
import { setAuthCookies, clearAuthCookies } from '../utils/cookie.util';

export class AuthController {
  static async register(req: Request, res: Response, next: NextFunction) {
    try {
      const { email, password, name, phone } = req.body;

      // Forward to Backend (5001) for DB operations
      const { data, ok, status } = await internalPost(`${config.backendAuthUrl}/register`, { 
        email, password, name, phone 
      });

      if (!ok) {
        throw new AppError(mapAuthError(data.error || 'Registration failed'), status);
      }

      // Logic: Strip ID from user object before sending to frontend
      const { id, ...userWithoutId } = data.user;

      res.status(201).json({
        message: 'User registered successfully',
        user: userWithoutId,
      });
    } catch (error) {
      next(error);
    }
  }

  static async login(req: Request, res: Response, next: NextFunction) {
    try {
      const { email, password, action, force_log_token } = req.body;
      const ip = requestIp.getClientIp(req) || 'unknown';
      const userAgent = req.headers['user-agent'] || 'unknown';

      // Forward to Backend (5001) for DB and Auth logic
      const { data, ok, status } = await internalPost(`${config.backendAuthUrl}/login`, { 
        email, password, action, ip, userAgent, force_log_token 
      });

      if (status === 409) {
        return res.status(409).json(data);
      }

      if (!ok) {
        throw new AppError(mapAuthError(data.error || 'Invalid credentials'), status);
      }

      // Logic: Generate Access Token in Middle Layer
      const accessToken = TokenUtil.generateAccessToken({ userId: data.user.id });

      // Set Cookies in Middle Layer
      const { tokens, user } = data;
      setAuthCookies(res, { accessToken, ...tokens });

      // Logic: Strip ID from user object before sending to frontend
      const { id, ...userWithoutId } = user;

      res.status(200).json({
        message: 'Login successful',
        user: userWithoutId
      });
    } catch (error) {
      next(error);
    }
  }

  static async refreshToken(req: Request, res: Response, next: NextFunction) {
    try {
      const accessTokenFromCookie = req.cookies?.accessToken || req.headers.authorization?.split(' ')[1];
      const refreshToken = req.cookies?.refreshToken;

      if (!refreshToken) {
        throw new AppError('Unauthorized - Refresh token missing', 401);
      }

      // Decode existing token to get userId (if possible) for the backend
      let userId = null;
      if (accessTokenFromCookie) {
        const decoded = TokenUtil.decodeToken(accessTokenFromCookie) as any;
        userId = decoded?.userId;
      }

      // Forward to Backend (5001)
      const { data, ok, status } = await internalPost(`${config.backendAuthUrl}/refresh`, { 
        refreshToken, userId 
      });

      if (!ok) {
        if (data.clearCookies) {
          clearAuthCookies(res);
        }
        throw new AppError(mapAuthError(data.error || 'Token refresh failed'), status);
      }

      // Logic: Generate new Access Token in Middle Layer
      const newAccessToken = TokenUtil.generateAccessToken({ userId: data.userId });

      // Update Cookies
      setAuthCookies(res, { accessToken: newAccessToken, ...data.tokens });

      res.status(200).json({ message: 'Token refreshed' });
    } catch (error) {
      next(error);
    }
  }

  static async me(req: any, res: Response, next: NextFunction) {
    try {
      const userId = req.user?.id;

      if (!userId) {
        throw new AppError('Unauthorized', 401);
      }

      // Forward to Backend (5001) to fetch full profile and groups
      const { data, ok, status } = await internalPost(`${config.backendAuthUrl}/me`, { 
        userId 
      });

      if (!ok) {
        throw new AppError(data.error || 'Failed to fetch user data', status);
      }

      res.status(200).json(data);
    } catch (error) {
      next(error);
    }
  }

  static async logout(req: Request, res: Response, next: NextFunction) {
    try {
      const refreshToken = req.cookies?.refreshToken;

      if (!refreshToken) {
        throw new AppError('Refresh token missing', 401);
      }

      // Forward to Backend (5001)
      const { data, ok, status } = await internalPost(`${config.backendAuthUrl}/logout`, { 
        refreshToken 
      });

      if (!ok) {
        throw new AppError(mapAuthError(data.error || 'Logout failed'), status);
      }

      // Clear Cookies in Middle Layer
      clearAuthCookies(res);

      res.status(200).json({ message: 'Logged out successfully' });
    } catch (error) {
      next(error);
    }
  }
}
