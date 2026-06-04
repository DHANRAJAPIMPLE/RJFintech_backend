import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../../lib/prisma';

const HIDDEN_ADMIN_ROLE_CODES = ['SAAS_ADMIN', 'CORP_ADMIN'];

type RoleLookupInput = {
  roleName: string;
  roleCategory: string;
  roleSubCategory: string;
};

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
      const hasBatchRoleLookups =
        Array.isArray(req.body?.permissions) || Array.isArray(req.body?.roles);
      const roleLookups = Array.isArray(req.body?.permissions)
        ? req.body.permissions
        : Array.isArray(req.body?.roles)
          ? req.body.roles
          : null;

      if (hasBatchRoleLookups && (!roleLookups || roleLookups.length === 0)) {
        res.status(200).json([]);
        return;
      }

      if (roleLookups && roleLookups.length > 0) {
        const normalizedLookups: RoleLookupInput[] = roleLookups.filter(
          (lookup: any): lookup is RoleLookupInput =>
            typeof lookup?.roleName === 'string' &&
            typeof lookup?.roleCategory === 'string' &&
            typeof lookup?.roleSubCategory === 'string',
        );
        if (normalizedLookups.length === 0) {
          res.status(200).json([]);
          return;
        }
        const uniqueLookups = Array.from(
          new Map(
            normalizedLookups.map((lookup) => [
              `${lookup.roleName}|${lookup.roleCategory}|${lookup.roleSubCategory}`,
              lookup,
            ]),
          ).values(),
        );
        if (uniqueLookups.length === 0) {
          res.status(200).json([]);
          return;
        }
        const roles = await prisma.roles.findMany({
          where: {
            OR: uniqueLookups.map((lookup) => ({
              roleName: lookup.roleName,
              category: lookup.roleCategory,
              subCategory: lookup.roleSubCategory,
              isActive: true,
            })),
          },
        });
        res.status(200).json(roles);
        return;
      }

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
