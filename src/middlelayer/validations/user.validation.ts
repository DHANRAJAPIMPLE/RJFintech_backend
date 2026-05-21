/**
 * User Validation:
 * Handles data validation for user onboarding and management.
 *
 * Why we use it:
 * - To validate complex nested objects containing user profile info and multi-dimensional permissions.
 * - To enforce business rules like "Exactly one PRIMARY permission is required" using Zod refinements.
 * - To validate unique identifiers like UUIDs and email addresses for user actions and history.
 */
import { z } from 'zod';
import {
  emailSchema,
  nameSchema,
  numberWithDefaultSchema,
  optionalCursorTokenSchema,
  optionalTrimmedStringSchema,
  optionalUuidSchema,
  paginationSchema,
} from './common.validation';

const phoneSchema = z
  .string()
  .trim()
  .regex(/^\d{10,15}$/, 'Phone number must be between 10 and 15 digits');

export const userOnboardingSchema = z.object({
  companyId: optionalUuidSchema('company ID'),
  basicDetails: z
    .object({
      name: nameSchema()
        .min(2, 'Name must be at least 2 characters')
        .max(20, 'Name too long'),
      email: emailSchema,
      phone: phoneSchema,
      designation: z
        .string()
        .trim()
        .min(2, 'Designation must be at least 2 characters')
        .max(100, 'Designation too long')
        .optional()
        .nullable(),
      employeeId: z
        .string()
        .trim()
        .min(2, 'Employee ID must be at least 2 characters')
        .max(50, 'Employee ID too long')
        .optional()
        .nullable(),
      reportingManager: emailSchema.optional().nullable(),
    })
    .strict(),
  permissions: z
    .array(
      z
        .object({
          accessType: z.enum(['PRIMARY', 'SECONDARY']),
          roleName: nameSchema('Role name').min(1, 'Role name is required'),
          roleCategory: z.string().trim().min(1, 'Role category is required'),
          roleSubCategory: z
            .string()
            .trim()
            .min(1, 'Role sub-category is required'),
          nodeName: nameSchema('Node name').min(1, 'Node name is required'),
          nodePath: z.string().trim().min(1, 'Node path is required'),
          accessCategory: z
            .enum(['ALL_CHILD', 'IMMEDIATE_CHILD', 'NODE'])
            .nullable()
            .optional(),
        })
        .strict(),
    )
    .min(1, 'At least one permission is required')
    .refine(
      (permissions) =>
        permissions.filter((p) => p.accessType === 'PRIMARY').length === 1,
      {
        message: 'Exactly one PRIMARY permission is required',
        path: ['permissions'],
      },
    ),
  levelsHash: z.string().nullable().optional(),
});

export const userListSchema = z
  .object({
    companyCode: z.string().trim().min(1, 'Company code is required'),
    page: numberWithDefaultSchema({
      fieldName: 'Page',
      defaultValue: 1,
      min: 1,
    }),
    direction: z.preprocess(
      (value) => {
        if (value === undefined || value === null || value === '') {
          return undefined;
        }

        return typeof value === 'string' ? value.trim().toLowerCase() : value;
      },
      z
        .enum(['next', 'prev', 'previous'])
        .optional()
        .default('next')
        .transform((value) => (value === 'previous' ? 'prev' : value)),
    ),
    cursor: optionalCursorTokenSchema('Cursor'),
    prevCursor: optionalCursorTokenSchema('Previous cursor'),
    nextCursor: optionalCursorTokenSchema('Next cursor'),
    cursorId: optionalCursorTokenSchema('Cursor'),
    topCursor: optionalCursorTokenSchema('Top cursor'),
    ...paginationSchema,
  })
  .strict();

export const userFilterOptionsSchema = z
  .object({
    companyCode: optionalTrimmedStringSchema('Company code'),
  })
  .strict();

export const userActionSchema = z
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

export const userStatusUpdateSchema = z
  .object({
    email: emailSchema,
  })
  .strict();

export const userHistory = z
  .object({
    email: emailSchema,
    companyCode: z.string().trim().min(1, 'Company code is required'),
  })
  .strict();

export const userCompanyNodesSchema = z.object({
  subCategory: z
    .enum(['USER_ACC', 'WORK_FLOW', 'ORG_STR'])
    .nullable()
    .optional(),
});

export const userFetchByNodePathCountSchema = z.object({
  nodePath: z.string().trim().min(1, 'Node path is required'),
});
