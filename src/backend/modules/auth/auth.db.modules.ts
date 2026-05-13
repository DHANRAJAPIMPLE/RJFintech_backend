import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../../lib/prisma';
import { Status } from '@prisma/client';
import { NodeAccessUtil } from '../../utils/node-access.util';

/**
 * Controller for handling authentication and low-level authorization database operations.
 * Manages user sessions, token activity, and permission validation.
 */
export class AuthDbController {
  /**
   * Fetches a user by ID or Email.
   * Includes full mapping details, company info, and group associations.
   * Used for initial login and token payload generation.
   */
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

  /**
   * Retrieves active session activity for a user.
   * Sessions are tracked per User + Company combination to support multi-tenancy.
   */
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

  /**
   * Updates or creates a session activity record.
   * Used during login or token refresh to track the current active session.
   */
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

  /**
   * Invalidates a session by clearing the refresh token data.
   * Effectively logs the user out from a specific device/session.
   */
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

  /**
   * Internal method to create a new production User record.
   */
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

  /**
   * Checks if a user possesses the 'SAAS_ADMIN' role in any active company mapping.
   */
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

  /**
   * Centralized permission validator.
   * A user is authorized if they satisfy ANY of these conditions in the target company:
   * 1. Have the 'SAAS_ADMIN' role.
   * 2. Have 'isGlobalAccess' enabled.
   * 3. Have a specific Role that grants the requested 'action' (view/modify/approve/initiate)
   *    for the specified 'module'.
   *
   * If 'targetNode' is provided, the permission must specifically exist for that node
   * (or be granted by a global role).
   */
  static async getUserAccess(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId, companyId, module, action, targetNode, body } = req.body;
      if (!userId || !companyId || !module || !action) {
        return res
          .status(400)
          .json({ error: 'userId, companyId, module and action are required' });
      }

      // For 'initiate', use the node-aware utility as the source of truth.
      if (action === 'initiate') {
        const authorized = await NodeAccessUtil.verifyInitiationAccess(
          userId,
          companyId,
          module,
          body,
        );
        return res.status(200).json({ authorized });
      }

      // Fallback to general role-based check (SAAS_ADMIN, GlobalAccess, or specific node role)
      const resolvedNodeId = targetNode
        ? await AuthDbController.resolveNodeId(companyId, targetNode)
        : null;

      const userAccess = await prisma.userAccess.findMany({
        where: {
          userId,
          companyId,
          // Ensure the user is still ACTIVE in this company
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
              // If node context is provided, role must be assigned to that specific node
              ...(resolvedNodeId ? { nodeId: resolvedNodeId } : {}),
            },
          ],
        },
      });

      res.status(200).json({ authorized: userAccess.length > 0 });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Resolves a node identifier (ID or Path) to a specific nodeId.
   */
  private static async resolveNodeId(
    companyId: string,
    targetNode: string,
  ): Promise<string | null> {
    if (!targetNode) return null;

    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(targetNode)) {
      return targetNode;
    }

    const node = await prisma.orgStructure.findFirst({
      where: { companyId, nodePath: targetNode },
      select: { id: true },
    });

    return node?.id || null;
  }
}
