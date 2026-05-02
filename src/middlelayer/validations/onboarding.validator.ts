import { z } from 'zod';

const phoneSchema = z
  .string()
  .trim()
  .regex(/^\d{10,15}$/, 'Phone number must be between 10 and 15 digits');

const groupCodeSchema = z
  .string()
  .trim()
  .min(3, 'Group code must be at least 3 characters')
  .max(20, 'Group code too long')
  .nullable()
  .optional();

export const roleUpsertSchema = z.array(
  z
    .object({
      roleName: z.string().trim().min(1, 'Role name is required'),
      category: z.string().trim().min(1, 'Category is required'),
      subCategory: z.string().trim().min(1, 'Sub-category is required'),
      permissionLevel: z.number().int().min(0, 'Permission level must be >= 0'),
    })
    .strict(),
);
