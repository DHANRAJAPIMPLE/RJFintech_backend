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
  optionalCursorTokenSchema,
  paginationSchema,
} from './common.validation';

const phoneSchema = z
  .string()
  .trim()
  .regex(/^\d{10,15}$/, 'Phone number must be between 10 and 15 digits');

const permissionSchema = z
  .object({
    accessType: z.enum(['PRIMARY', 'SECONDARY']),
    roleName: nameSchema('Role name').min(1, 'Role name is required'),
    roleCategory: z.string().trim().min(1, 'Role category is required'),
    roleSubCategory: z.string().trim().min(1, 'Role sub-category is required'),
    nodeName: nameSchema('Node name').min(1, 'Node name is required'),
    nodePath: z.string().trim().min(1, 'Node path is required'),
    accessCategory: z
      .enum(['ALL_CHILD', 'IMMEDIATE_CHILD', 'NODE'])
      .nullable()
      .optional(),
  })
  .strict();

const normalizeUserListType = (value: unknown) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

const requiredUserListTypeSchema = z.preprocess(
  normalizeUserListType,
  z.enum(['active', 'pending', 'inactive']),
);

const optionalUserSearchQuerySchema = z.preprocess((value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return value;

  const query = value.trim();
  return query || undefined;
}, z.string().max(150, 'Query is too long').optional());

export const userOnboardingSchema = z
  .object({
    type: z
      .preprocess(
        (value) =>
          typeof value === 'string' ? value.trim().toLowerCase() : value,
        z.literal('initiate'),
      )
      .optional(),
    targetUserEmail: emailSchema.nullable().optional(),
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
      .array(permissionSchema)
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
  })
  .strict();

const normalizeRequestType = (value: unknown) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

const userPermissionMutationSchema = permissionSchema.extend({
  operation: z.preprocess(
    (value) => (typeof value === 'string' ? value.trim().toUpperCase() : value),
    z.enum(['ADD', 'UPDATE', 'REMOVE']).optional(),
  ),
  remove: z.boolean().optional(),
});

export const userModificationSchema = z
  .object({
    type: z.preprocess(
      normalizeRequestType,
      z.enum(['update', 'active', 'inactive', 'archive']),
    ),
    targetUserEmail: emailSchema,
    basicDetails: z
      .object({
        name: nameSchema()
          .min(2, 'Name must be at least 2 characters')
          .max(20, 'Name too long')
          .optional(),
        email: emailSchema.optional(),
        phone: phoneSchema.optional(),
        designation: z
          .string()
          .trim()
          .min(2, 'Designation must be at least 2 characters')
          .max(100, 'Designation too long')
          .nullable()
          .optional(),
        employeeId: z
          .string()
          .trim()
          .min(2, 'Employee ID must be at least 2 characters')
          .max(50, 'Employee ID too long')
          .nullable()
          .optional(),
        reportingManager: emailSchema.nullable().optional(),
      })
      .strict()
      .optional(),
    permissions: z.array(userPermissionMutationSchema).optional(),
    levelsHash: z.string().nullable().optional(),
    remarks: z
      .string()
      .trim()
      .min(2, 'Please enter a remark with at least 2 characters')
      .max(500, 'Remark must be 500 characters or fewer')
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.type === 'update' &&
      !value.basicDetails &&
      (!value.permissions || value.permissions.length === 0)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'At least one changed field or permission is required',
        path: ['type'],
      });
    }
  });

export const userListSchema = z
  .object({
    type: z.preprocess(
      normalizeUserListType,
      z.enum(['active', 'pending', 'inactive']).optional(),
    ),
    query: optionalUserSearchQuerySchema,
    page: z.preprocess(
      (value) =>
        value === undefined || value === null || value === ''
          ? undefined
          : value,
      z.coerce
        .number()
        .int('Page must be an integer')
        .min(1, 'Page must be greater than or equal to 1')
        .optional(),
    ),
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

export const fetchAllUserSchema = userListSchema.extend({
  type: requiredUserListTypeSchema,
});

export const userDetailsSchema = z
  .object({
    id: z.string().uuid('Request ID is invalid').optional(),
    email: emailSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.id && !value.email) {
      context.addIssue({
        code: 'custom',
        message: 'id or email is required',
        path: ['id'],
      });
    }
  });

export const userFilterOptionsSchema = z.object({}).strict();

export const userActionSchema = z
  .object({
    id: z.string().uuid('Request ID is invalid'),
    action: z.enum(['approve', 'reject']),
    remark: z
      .string()
      .trim()
      .min(2, 'Please enter an approval remark with at least 2 characters')
      .max(500, 'Approval remark must be 500 characters or fewer'),
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
