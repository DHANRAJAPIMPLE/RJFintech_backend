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
  z.enum(['active', 'pending', 'inactive', 'archive']),
);

const optionalUserSearchQuerySchema = z.preprocess((value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return value;

  const query = value.trim();
  return query || undefined;
}, z.string().max(150, 'Query is too long').optional());

const optionalStringArraySchema = z.preprocess(
  (value) => {
    if (value === undefined || value === null) return undefined;
    if (Array.isArray(value)) {
      return value.map((item) => {
        if (item && typeof item === 'object') {
          const source = item as Record<string, unknown>;
          return source.value ?? source.label ?? source.name ?? item;
        }

        return item;
      });
    }
    return value;
  },
  z.array(z.string().trim().min(1)).nullable().optional(),
);

const optionalNodeFilterOptionArraySchema = z
  .array(
    z
      .object({
        value: z.string().trim().min(1),
        path: z.string().trim().min(1).optional(),
        nodeName: z.string().trim().min(1).optional(),
        nodePath: z.string().trim().min(1).optional(),
        label: z.string().trim().min(1).optional(),
        count: z.coerce.number().int().nonnegative().optional(),
        levelCount: z.coerce.number().int().positive().optional(),
      })
      .passthrough(),
  )
  .nullable()
  .optional();

const optionalIntegerArraySchema = ({
  min,
  max,
  field,
}: {
  min: number;
  max: number;
  field: string;
}) =>
  z.preprocess(
    (value) => {
      if (value === undefined || value === null) return undefined;
      if (Array.isArray(value)) {
        return value.map((item) => {
          if (item && typeof item === 'object') {
            const source = item as Record<string, unknown>;
            return source.value ?? item;
          }

          return item;
        });
      }
      return value;
    },
    z
      .array(
        z.coerce
          .number()
          .int(`${field} must be an integer`)
          .min(min, `${field} must be between ${min} and ${max}`)
          .max(max, `${field} must be between ${min} and ${max}`),
      )
      .nullable()
      .optional(),
  );

const optionalDateStringSchema = z.preprocess(
  (value) => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    return value;
  },
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
    .optional(),
);

const fetchAllUserAppliedSchema = z
  .object({
    designation: optionalStringArraySchema,
    nodeName: z
      .object({
        values: optionalStringArraySchema,
        nodeAccess: z
          .preprocess(
            (value) => {
              if (value === undefined || value === null) return undefined;
              if (typeof value === 'string') {
                // Backward compat: treat a bare string as legacy format
                const trimmed = value.trim().toLowerCase();
                if (trimmed === 'primary' || trimmed === 'secondary') {
                  return trimmed;
                }
                return value;
              }
              return value;
            },
            z
              .union([
                // Legacy: single "primary" | "secondary" string
                z.enum(['primary', 'secondary']),
                // New: per-node access map, e.g. { "NEXORA": ["Primary","Secondary"] }
                z.record(
                  z.string(),
                  z.array(
                    z.preprocess(
                      (v) =>
                        typeof v === 'string' ? v.trim() : v,
                      z.string().min(1),
                    ),
                  ),
                ),
              ])
              .nullable()
              .optional(),
          )
          .optional(),
      })
      .strict()
      .nullable()
      .optional(),
    nodeType: optionalStringArraySchema,
    category: optionalStringArraySchema,
    subCategory: optionalStringArraySchema,
    reportingManager: optionalStringArraySchema,
    onboardingDate: z
      .object({
        dateRange: z
          .preprocess(
            (value) =>
              typeof value === 'string' ? value.trim().toUpperCase() : value,
            z
              .enum(['7DAYS', '15DAYS', '1MONTH', '1YEAR', 'CUSTOM'])
              .nullable()
              .optional(),
          )
          .optional(),
        fromDate: optionalDateStringSchema.nullable().optional(),
        toDate: optionalDateStringSchema.nullable().optional(),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.dateRange !== 'CUSTOM') return;

        if (!value.fromDate || !value.toDate) {
          context.addIssue({
            code: 'custom',
            message: 'fromDate and toDate are required when dateRange is CUSTOM',
            path: ['fromDate'],
          });
          return;
        }

        const fromDate = new Date(value.fromDate);
        const toDate = new Date(value.toDate);
        if (
          Number.isNaN(fromDate.getTime()) ||
          Number.isNaN(toDate.getTime()) ||
          fromDate.getTime() > toDate.getTime()
        ) {
          context.addIssue({
            code: 'custom',
            message: 'fromDate must be earlier than or equal to toDate',
            path: ['toDate'],
          });
        }
      })
      .nullable()
      .optional(),
    status: optionalStringArraySchema,
    role: optionalStringArraySchema,
    currentStatus: z
      .preprocess(
        (value) =>
          typeof value === 'string' ? value.trim().toLowerCase() : value,
        z.enum(['initiate', 'modify']).nullable().optional(),
      )
      .optional(),
    hasPending: z
      .preprocess(
        (value) =>
          typeof value === 'string' ? value.trim().toLowerCase() : value,
        z.enum(['yes', 'no']).nullable().optional(),
      )
      .optional(),
  })
  .strict();

const workflowCompanyNodeAppliedSchema = z
  .object({
    nodeName: z
      .union([
        z
          .object({
            values: z
              .union([
                optionalNodeFilterOptionArraySchema,
                optionalStringArraySchema,
              ])
              .optional(),
          })
          .strict()
          .nullable()
          .optional(),
        optionalNodeFilterOptionArraySchema,
        optionalStringArraySchema,
      ])
      .optional(),
    nodeType: optionalStringArraySchema,
    workflowType: optionalStringArraySchema,
    module: optionalStringArraySchema,
    subCategory: optionalStringArraySchema,
    subModule: optionalStringArraySchema,
    checker: optionalIntegerArraySchema({
      min: 1,
      max: 10,
      field: 'Checker count',
    }),
    checkerCount: optionalIntegerArraySchema({
      min: 1,
      max: 10,
      field: 'Checker count',
    }),
    checkers: optionalIntegerArraySchema({
      min: 1,
      max: 10,
      field: 'Checker count',
    }),
    workflowLevels: z
      .union([
        optionalIntegerArraySchema({
          min: 1,
          max: 10,
          field: 'Workflow level count',
        }),
        z.coerce
          .number()
          .int('Workflow level count must be an integer')
          .min(1, 'Workflow level count must be between 1 and 10')
          .max(10, 'Workflow level count must be between 1 and 10')
          .nullable()
          .optional(),
      ])
      .optional(),
    workflowLevel: optionalIntegerArraySchema({
      min: 1,
      max: 10,
      field: 'Workflow level count',
    }),
    levels: z
      .union([
        optionalStringArraySchema,
        z
          .array(
            z
              .object({
                count: z.coerce
                  .number()
                  .int('Level count must be an integer')
                  .min(1, 'Level count must be between 1 and 5')
                  .max(5, 'Level count must be between 1 and 5'),
                approverType: z.string().trim().min(1).optional(),
              })
              .strict(),
          )
          .nullable()
          .optional(),
      ])
      .optional(),
    approverType: optionalStringArraySchema,
    hasLinkedOrg: z
      .preprocess(
        (value) =>
          typeof value === 'string' ? value.trim().toLowerCase() : value,
        z.enum(['yes', 'no']).nullable().optional(),
      )
      .optional(),
    onboardingDate: z
      .object({
        dateRange: z
          .preprocess(
            (value) =>
              typeof value === 'string' ? value.trim().toUpperCase() : value,
            z
              .enum(['7DAYS', '15DAYS', '1MONTH', '1YEAR', 'CUSTOM'])
              .nullable()
              .optional(),
          )
          .optional(),
        fromDate: optionalDateStringSchema.nullable().optional(),
        toDate: optionalDateStringSchema.nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

const fetchAllUserPaginationSchema = z
  .object({
    statusType: requiredUserListTypeSchema,
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
    cursor: optionalCursorTokenSchema('Cursor').nullable().optional(),
    prevCursor: optionalCursorTokenSchema('Previous cursor')
      .nullable()
      .optional(),
    nextCursor: optionalCursorTokenSchema('Next cursor')
      .nullable()
      .optional(),
    cursorId: optionalCursorTokenSchema('Cursor').nullable().optional(),
    topCursor: optionalCursorTokenSchema('Top cursor').nullable().optional(),
    ...paginationSchema,
  })
  .strict();

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
    statusType: z.preprocess(
      normalizeUserListType,
      z.enum(['active', 'pending', 'inactive', 'archive']).optional(),
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

export const fetchAllUserSchema = userListSchema
  .extend({
    statusType: requiredUserListTypeSchema.optional(),
    filter: z.boolean().optional(),
    pagination: fetchAllUserPaginationSchema.optional(),
    applied: fetchAllUserAppliedSchema.nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const statusType = value.pagination?.statusType ?? value.statusType;
    if (!statusType) {
      context.addIssue({
        code: 'custom',
        message: 'statusType is required',
        path: ['statusType'],
      });
    }
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
  filter: z.boolean().optional(),
  applied: z
    .union([fetchAllUserAppliedSchema, workflowCompanyNodeAppliedSchema])
    .nullable()
    .optional(),
});

export const userFetchByNodePathCountSchema = z.object({
  nodePath: z.string().trim().min(1, 'Node path is required'),
});
