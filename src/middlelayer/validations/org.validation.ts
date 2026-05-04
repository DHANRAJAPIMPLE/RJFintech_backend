/**
 * Org Validation:
 * Defines schemas for managing organizational structure changes.
 * 
 * Why we use it:
 * - To validate requests for creating new organizational nodes (type, name, parent context).
 * - To ensure that approval/rejection actions on org changes include required metadata and remarks.
 * - To enforce correct formatting for company-wide organizational history lookups.
 */
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

export const orgOnboardingSchema = z
  .object({
    companyCode: z.string().trim().min(1, 'Company code is required'),
    newNodeName: z.string().trim().min(1, 'New node name is required'),
    nodeType: z.enum(['ROOT', 'DEPARTMENT', 'TEAM', 'PLANT', 'LOCATION']),
    parentNode: z.object({
      nodeName: z.string().trim().min(1, 'Node name is required'),
      nodePath: z.string().trim().min(1, 'Node path is required'),
    }),
  })
  .strict();

export const orgOnboardingAction = z
  .object({
    id: z.string().uuid('Invalid onboarding ID'),
    action: z.enum(['approve', 'reject']),
    remark: z
      .string()
      .trim()
      .min(2, 'Remark is too short')
      .max(500, 'Remark too long'),
  })
  .strict();

export const orgHistory = z
  .object({
    companyCode: z.string().trim().min(1, 'Company code is required'),
  })
  .strict();
