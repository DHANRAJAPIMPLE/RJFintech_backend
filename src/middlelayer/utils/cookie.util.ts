import type { Response } from 'express';
import { config } from '../config';

/**
 * COOKIE UTILITY LOGIC:
 * Standardizes how authentication cookies are set and cleared across the middle layer.
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
