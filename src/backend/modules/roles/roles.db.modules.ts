import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../../lib/prisma';

export class RolesDbController {
  static async upsertRole(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        roleCode,
        roleName,
        category,
        subCategory,
        permissionLevel,
        capabilities,
        isActive,
      } = req.body;

      const createdRole = await prisma.roles.upsert({
        where: { roleCode },
        update: {
          roleName,
          category,
          subCategory,
          permissionLevel,
          view: capabilities?.view ?? false,
          modify: capabilities?.modify ?? false,
          approve: capabilities?.approve ?? false,
          initiate: capabilities?.initiate ?? false,
          isActive: isActive ?? true,
        },
        create: {
          roleCode,
          roleName,
          category,
          subCategory,
          permissionLevel,
          view: capabilities?.view ?? false,
          modify: capabilities?.modify ?? false,
          approve: capabilities?.approve ?? false,
          initiate: capabilities?.initiate ?? false,
          isActive: isActive ?? true,
        },
      });

      res.status(200).json(createdRole);
    } catch (error) {
      next(error);
    }
  }

  static async fetchAllRoles(req: Request, res: Response, next: NextFunction) {
    try {
      const roles = await prisma.roles.findMany({ where: { isActive: true } });
      res.status(200).json(roles);
    } catch (error) {
      next(error);
    }
  }
}
