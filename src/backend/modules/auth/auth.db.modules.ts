import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../../lib/prisma';
import { Status } from '@prisma/client';

export class AuthDbController {
  static async getByUser(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId, email } = req.body;

      if (!userId && !email) {
        return res.status(400).json({ error: 'userId or email is required' });
      }

      const whereCondition = userId ? { id: userId } : { email: email };

      const user = await prisma.user.findUnique({
        where: whereCondition,
        include: {
          userMappings: {
            include: {
              company: {
                include: {
                  companyMappings: {
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
        return res.status(404).json({ error: 'User not found' });
      }

      res.status(200).json(user);
    } catch (error) {
      next(error);
    }
  }

  static async getActivity(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId, refreshTokenHash, companyId } = req.body;

      if (!userId && !refreshTokenHash) {
        return res.status(400).json({
          error: 'userId or refreshTokenHash is required',
        });
      }

      const activity = await prisma.userActivity.findFirst({
        where: {
          OR: [
            userId && companyId
              ? { userId, companyId }
              : userId
                ? { userId }
                : undefined,
            refreshTokenHash ? { refreshToken: refreshTokenHash } : undefined,
          ].filter(Boolean) as any,
        },
        include: {
          user: {
            include: {
              userMappings: {
                include: {
                  company: true,
                },
              },
            },
          },
        },
      });

      if (!activity) {
        return res.status(404).json({ error: 'Activity not found' });
      }

      res.status(200).json(activity);
    } catch (error) {
      next(error);
    }
  }

  static async upsertActivity(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId, data } = req.body;

      const existingActivity = await prisma.userActivity.findFirst({
        where: {
          userId,
          companyId: data.companyId,
        },
      });

      let activity;
      if (existingActivity) {
        activity = await prisma.userActivity.update({
          where: { id: existingActivity.id },
          data,
        });
      } else {
        activity = await prisma.userActivity.create({
          data: {
            userId,
            ...data,
          },
        });
      }

      res.status(200).json(activity);
    } catch (error) {
      next(error);
    }
  }

  static async deleteActivity(req: Request, res: Response, next: NextFunction) {
    try {
      const { refreshTokenHash } = req.body;
      await prisma.userActivity.updateMany({
        where: { refreshToken: refreshTokenHash },
        data: { refreshToken: null, version: null, expiryAt: null },
      });
      res.status(200).json({ message: 'Activity deleted' });
    } catch (error) {
      next(error);
    }
  }

  static async createUser(req: Request, res: Response, next: NextFunction) {
    try {
      const { email, password, name, phone } = req.body;
      const user = await prisma.user.create({
        data: {
          email,
          password,
          name,
          phone,
        },
      });

      res.status(201).json(user);
    } catch (error) {
      next(error);
    }
  }

  static async getUserAdminRole(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { userId } = req.body;
      const userAccess = await prisma.userAccess.findMany({
        where: {
          userId,
          roleCode: 'SAAS_ADMIN',
          user: {
            userMappings: {
              some: {
                status: Status.ACTIVE,
              },
            },
          },
        },
      });

      res.status(200).json(userAccess);
    } catch (error) {
      next(error);
    }
  }

  static async getUserAccess(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId, companyId, module, action } = req.body;
      if (!userId || !companyId || !module || !action) {
        return res
          .status(400)
          .json({ error: 'userId, companyId, module and action are required' });
      }

      const isAuthorized = await prisma.userAccess.findFirst({
        where: {
          userId,
          companyId,
          user: {
            userMappings: {
              some: {
                companyId,
                status: Status.ACTIVE,
              },
            },
          },
          OR: [
            { roleCode: 'SAAS_ADMIN' },
            { isGlobalAccess: true },
            {
              role: {
                subCategory: module,
                [action]: true,
              },
            },
          ],
        },
      });

      res.status(200).json({ authorized: !!isAuthorized });
    } catch (error) {
      next(error);
    }
  }
}
