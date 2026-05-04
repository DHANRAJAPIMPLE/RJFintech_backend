import type { Response } from 'express';
import { config } from '../config';

/**
 * Cookie Utility:
 * Standardizes the setting and clearing of authentication cookies.
 *
 * Why we use it:
 * - To ensure security policies (httpOnly, secure, sameSite) are applied consistently.
 * - To manage the lifecycle of Access, Refresh, and Versioning cookies in a single place.
 */

export const setAuthCookies = (
  res: Response,
  tokens: { accessToken: string; refreshToken: string; versionHash: string },
) => {
  res.cookie('accessToken', tokens.accessToken, {
    ...config.cookieOptions,
    maxAge: config.accessTokenMaxAge,
  });
  res.cookie('refreshToken', tokens.refreshToken, {
    ...config.cookieOptions,
    maxAge: config.refreshTokenMaxAge,
  });
  res.cookie('versionHash', tokens.versionHash, {
    ...config.cookieOptions,
    maxAge: config.refreshTokenMaxAge,
  });
};

export const clearAuthCookies = (res: Response) => {
  res.clearCookie('accessToken');
  res.clearCookie('refreshToken');
  res.clearCookie('versionHash');
};
