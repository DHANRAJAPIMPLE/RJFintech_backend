import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../../lib/prisma';

const HIDDEN_ADMIN_ROLE_CODES = ['SAAS_ADMIN', 'CORP_ADMIN'];

/**
 * Controller for managing Role-Based Access Control (RBAC) roles.
 * Defines the permissions and capabilities available to users across different modules.
 */
export class RolesDbController {
  /**
   * Creates or updates a role definition.
   * Logic:
   * - Uses 'upsert' to ensure that roleCode remains unique.
   * - Maps the 'capabilities' object from the UI to discrete boolean flags
   *   (view, modify, approve, initiate) in the database for high-performance querying.
   */
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

  /**
   * Fetches all roles defined in the system, excluding system-level administrative roles.
   */
  static async fetchAllRoles(_req: Request, res: Response, next: NextFunction) {
    try {
      const roles = await prisma.roles.findMany({
        where: {
          roleCode: { notIn: HIDDEN_ADMIN_ROLE_CODES },
        },
      });
      res.status(200).json(roles);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Fetches specific roles based on their name, category, and sub-category.
   * Used during onboarding to validate that requested roles exist.
   */
  static async fetchRole(req: Request, res: Response, next: NextFunction) {
    try {
      const { roleName, roleCategory, roleSubCategory } = req.body;
      const roles = await prisma.roles.findMany({
        where: {
          roleName,
          category: roleCategory,
          subCategory: roleSubCategory,
          isActive: true,
        },
      });
      res.status(200).json(roles);
    } catch (error) {
      next(error);
    }
  }
}
