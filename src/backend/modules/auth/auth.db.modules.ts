import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../../lib/prisma';
import { HashUtil } from '../../../shared/utils/hash.util';

/**
 * AUTH DB MODULE HELPERS:
 */
const bumpVersion = (currentVersion: string | null | undefined): string => {
  const num = parseInt((currentVersion ?? 'v0').replace('v', ''), 10);
  return `v${isNaN(num) ? 1 : num + 1}`;
};

const hoursFromNow = (hours: number): Date => {
  const d = new Date();
  d.setHours(d.getHours() + hours);
  return d;
};

export class AuthDbController {
  static async register(req: Request, res: Response, next: NextFunction) {
    try {
      const { email, password, name, phone } = req.body;

      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (existingUser) {
        return res.status(400).json({ error: 'User already exists' });
      }

      const hashedPassword = await HashUtil.hash(password);

      const user = await prisma.user.create({
        data: {
          email,
          password: hashedPassword,
          name,
          phone,
        },
      });

      res.status(201).json({
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  static async login(req: Request, res: Response, next: NextFunction) {
    try {
      const { email, password, action, ip, userAgent, force_log_token } =
        req.body;

      const user = await prisma.user.findUnique({
        where: { email },
        include: {
          user_mappings: {
            include: {
              company: {
                include: {
                  company_mappings: {
                    include: {
                      group: true,
                    },
                  },
                },
              },
            },
          },
        },
      });

      if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const isPasswordValid = await HashUtil.verify(user.password, password);
      if (!isPasswordValid) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const existingActivity = await prisma.user_activity.findFirst({
        where: { user_id: user.id },
      });

      if (
        existingActivity &&
        existingActivity.expiry_at &&
        existingActivity.expiry_at > new Date() &&
        existingActivity.refresh_token
      ) {
        if (action === 0) {
          const forceLogToken = HashUtil.generateRandomToken(64);
          const forceLogTokenHash = HashUtil.hashToken(forceLogToken);

          await prisma.user_activity.update({
            where: { id: existingActivity.id },
            data: { force_log_token: forceLogTokenHash },
          });

          return res.status(409).json({
            message: 'User already logged in another device',
            status: 1,
            forceLogToken,
          });
        }

        if (!force_log_token) {
          return res.status(400).json({ error: 'Force login token required' });
        }

        const providedTokenHash = HashUtil.hashToken(force_log_token);
        if (
          !existingActivity.force_log_token ||
          existingActivity.force_log_token !== providedTokenHash
        ) {
          return res.status(401).json({ error: 'Invalid force login token' });
        }
      }

      const refreshToken = HashUtil.generateRandomToken(32);
      const refreshTokenHash = HashUtil.hashToken(refreshToken);

      const nextVersion = bumpVersion(existingActivity?.version);
      const versionHash = HashUtil.hashToken(nextVersion);

      const expiryAt = hoursFromNow(24);

      if (existingActivity) {
        await prisma.user_activity.update({
          where: { id: existingActivity.id },
          data: {
            refresh_token: refreshTokenHash,
            version: nextVersion,
            ip_address: ip,
            user_agent: userAgent,
            expiry_at: expiryAt,
            force_log_token: null,
          },
        });
      } else {
        await prisma.user_activity.create({
          data: {
            user_id: user.id,
            refresh_token: refreshTokenHash,
            version: nextVersion,
            ip_address: ip,
            user_agent: userAgent,
            expiry_at: expiryAt,
          },
        });
      }

      // Logic: Group companies by their respective groups for the response
      const groupsMap = new Map<string, any>();

      user.user_mappings.forEach((um) => {
        const company = {
          legal_name: um.company.legal_name,
          brand_name: um.company.brand_name,
          company_code: um.company.company_code,
        };

        um.company.company_mappings.forEach((cm) => {
          if (cm.group) {
            const groupCode = cm.group.group_code;
            if (!groupsMap.has(groupCode)) {
              groupsMap.set(groupCode, {
                group_name: cm.group.name,
                group_code: cm.group.group_code,
                companies: [],
              });
            }
            const groupObj = groupsMap.get(groupCode);
            if (
              !groupObj.companies.some(
                (c: any) => c.company_code === company.company_code,
              )
            ) {
              groupObj.companies.push(company);
            }
          }
        });
      });

      const groups = Array.from(groupsMap.values());

      res.status(200).json({
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          groups,
        },
        tokens: {
          refreshToken,
          versionHash,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  static async refreshToken(req: Request, res: Response, next: NextFunction) {
    try {
      const { refreshToken, userId: providedUserId } = req.body;

      if (!refreshToken) {
        return res
          .status(401)
          .json({ error: 'Unauthorized - Refresh token missing' });
      }

      let userId = providedUserId;

      if (!userId) {
        const refreshTokenHash = HashUtil.hashToken(refreshToken);
        const activityByToken = await prisma.user_activity.findFirst({
          where: { refresh_token: refreshTokenHash },
        });
        userId = activityByToken?.user_id || null;
      }

      if (!userId) {
        return res
          .status(401)
          .json({ error: 'Unauthorized - Invalid session' });
      }

      const activity = await prisma.user_activity.findFirst({
        where: { user_id: userId },
        include: { user: true },
      });

      if (!activity || !activity.refresh_token) {
        return res
          .status(401)
          .json({ error: 'Unauthorized - Invalid token', clearCookies: true });
      }

      const refreshTokenHash = HashUtil.hashToken(refreshToken);
      if (activity.refresh_token !== refreshTokenHash) {
        return res.status(401).json({
          error: 'User already logged in another device',
          clearCookies: true,
        });
      }

      if (activity.expiry_at && activity.expiry_at < new Date()) {
        return res
          .status(401)
          .json({ error: 'Unauthorized - Invalid token', clearCookies: true });
      }

      const nextVersion = bumpVersion(activity.version);
      const versionHash = HashUtil.hashToken(nextVersion);

      const newRefreshToken = HashUtil.generateRandomToken(32);
      const newRefreshTokenHash = HashUtil.hashToken(newRefreshToken);

      const expiryAt = hoursFromNow(24);

      await prisma.user_activity.update({
        where: { id: activity.id },
        data: {
          refresh_token: newRefreshTokenHash,
          version: nextVersion,
          expiry_at: expiryAt,
        },
      });

      res.status(200).json({
        userId: activity.user_id,
        tokens: {
          refreshToken: newRefreshToken,
          versionHash,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  static async getMe(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = req.body;

      if (!userId) {
        return res
          .status(401)
          .json({ error: 'Unauthorized - User ID missing' });
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          name: true,
          email: true,
          phone: true,
          user_mappings: {
            include: {
              company: {
                select: {
                  legal_name: true,
                  brand_name: true,
                  company_code: true,
                  company_mappings: {
                    include: {
                      group: {
                        select: {
                          name: true,
                          group_code: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Logic: Group companies by their respective groups
      const groupsMap = new Map<string, any>();

      user.user_mappings.forEach((um) => {
        const company = {
          legal_name: um.company.legal_name,
          brand_name: um.company.brand_name,
          company_code: um.company.company_code,
        };

        um.company.company_mappings.forEach((cm) => {
          if (cm.group) {
            const groupCode = cm.group.group_code;
            if (!groupsMap.has(groupCode)) {
              groupsMap.set(groupCode, {
                group_name: cm.group.name,
                group_code: cm.group.group_code,
                companies: [],
              });
            }
            // Logic: Avoid duplicate companies in the same group
            const groupObj = groupsMap.get(groupCode);
            if (
              !groupObj.companies.some(
                (c: any) => c.company_code === company.company_code,
              )
            ) {
              groupObj.companies.push(company);
            }
          }
        });
      });

      const groups = Array.from(groupsMap.values());

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
      const { refreshToken } = req.body;

      if (!refreshToken) {
        return res.status(401).json({ error: 'Refresh token missing' });
      }

      const hash = HashUtil.hashToken(refreshToken);

      const result = await prisma.user_activity.updateMany({
        where: { refresh_token: hash },
        data: { refresh_token: null, version: null, expiry_at: null },
      });

      if (result.count === 0) {
        return res.status(401).json({ error: 'Invalid or expired session' });
      }

      res.status(200).json({ message: 'Logged out successfully' });
    } catch (error) {
      next(error);
    }
  }

  static async verifySession(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId, refreshToken, versionHashFromCookie } = req.body;

      const activity = await prisma.user_activity.findFirst({
        where: userId
          ? { user_id: userId }
          : { refresh_token: HashUtil.hashToken(refreshToken) },
      });

      if (!activity || !activity.refresh_token) {
        return res.status(401).json({ error: 'Unauthorized - Invalid token' });
      }

      const dbVersionHash = activity.version
        ? HashUtil.hashToken(activity.version)
        : null;

      if (dbVersionHash !== versionHashFromCookie) {
        return res
          .status(401)
          .json({ error: 'User already logged in another device' });
      }

      if (activity.expiry_at && activity.expiry_at < new Date()) {
        return res.status(401).json({ error: 'Unauthorized - Invalid token' });
      }

      if (
        refreshToken &&
        activity.refresh_token !== HashUtil.hashToken(refreshToken)
      ) {
        return res.status(401).json({ error: 'Unauthorized - Invalid token' });
      }

      res.status(200).json({
        isValid: true,
        userId: activity.user_id,
      });
    } catch (error) {
      next(error);
    }
  }
}
