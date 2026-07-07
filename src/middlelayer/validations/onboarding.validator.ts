/**
 * Onboarding Validator:
 * Contains shared validation schemas used across various onboarding processes.
 *
 * Why we use it:
 * - To define reusable schemas like 'phoneSchema' and 'groupCodeSchema'.
 * - It currently holds the 'roleUpsertSchema' for validating bulk role creation/updates.
 */
import { z } from 'zod';
import { nameSchema } from './common.validation';

export const roleUpsertSchema = z.array(
  z
    .object({
      roleName: nameSchema('Role name').min(1, 'Role name is required'),
      category: z.string().trim().min(1, 'Category is required'),
      subCategory: z.string().trim().min(1, 'Sub-category is required'),
      permissionLevel: z.number().int().min(0, 'Permission level must be >= 0'),
    })
    .strict(),
);
