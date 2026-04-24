import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../../lib/prisma';

export class RolesDbController {
  static async createRoles(req: Request, res: Response, next: NextFunction) {
    try {
      const rolesData = req.body;

      if (!Array.isArray(rolesData)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid data format. Expected an array of roles.',
        });
      }

      const results = [];

      for (const role of rolesData) {
        const {
          roleCode,
          roleName,
          category,
          subCategory,
          permissionLevel,
          capabilities,
          isActive,
        } = role;

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
        results.push(createdRole);
      }

      res.status(200).json({
        success: true,
        data: results,
      });
    } catch (error) {
      next(error);
    }
  }

  static async fetchAllRoles(req: Request, res: Response, next: NextFunction) {
    try {
      const roles = await prisma.roles.findMany({ where: { isActive: true } });

      const formattedRoles = roles.map((role) => ({
        roleName: role.roleName,
        category: role.category,
        subCategory: role.subCategory,
        permissionLevel: role.permissionLevel,
      }));

      res.status(200).json({
        success: true,
        data: formattedRoles,
      });
    } catch (error) {
      next(error);
    }
  }
}
