/**
 * Workflow Validation:
 * Defines schemas for complex workflow configuration and processing.
 *
 * Why we use it:
 * - To validate multi-level approval hierarchies (L1 through L5).
 * - To ensure that approver types (REPORTING_MANAGER, NODE_APPROVER, etc.)
 *   and logical operators (AND/OR) are correctly defined.
 * - To strictly type workflow initiation, actions, and history lookups.
 */
import { z } from 'zod';
import {
  cursorPaginationFields,
  nameSchema,
  optionalCursorTokenSchema,
  paginationSchema,
} from './common.validation';

const approverTypeEnum = z.enum([
  'GLOBAL_APPROVER',
  'REPORTING_MANAGER',
  'NODE_APPROVER',
  'HIERARCHY_APPROVER',
]);
const approvalTypeEnum = z.enum(['AND', 'OR']);

const levelSchema = z
  .object({
    approver1: approverTypeEnum,
    type: approvalTypeEnum.default('OR'),
    approver2: approverTypeEnum.nullable().optional(),
  })
  .nullable()
  .optional();

const levelsSchema = z.object({
  l1: levelSchema,
  l2: levelSchema,
  l3: levelSchema,
  l4: levelSchema,
  l5: levelSchema,
});

const normalizeRequestType = (value: unknown) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
const normalizeWorkflowType = (value: unknown) => {
  if (typeof value !== 'string') return value;
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  if (normalized === 'INITIATE') return 'NODE';
  if (
    normalized === 'IMMEDIATE_APPROVER' ||
    normalized === 'IMMEDATE_APPROVER' ||
    normalized === 'IMMEDIATE_CHILD'
  ) {
    return 'IMMEDIATE_CHILD';
  }
  if (normalized === 'ALL_CHILD') return 'ALL_CHILD';
  return normalized;
};
const normalizeApproverType = (value: unknown) => {
  if (typeof value !== 'string') return value;
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  if (normalized === 'ALL_HERARCHY' || normalized === 'HIERARCHY') {
    return 'HIERARCHY_APPROVER';
  }
  if (normalized === 'REPORTING_MANGER') {
    return 'REPORTING_MANAGER';
  }
  if (normalized === 'NODE_APPROER') {
    return 'NODE_APPROVER';
  }
  return normalized;
};
const requiredWorkflowListTypeSchema = z.preprocess(
  normalizeRequestType,
  z.enum(['active', 'pending', 'inactive', 'archive']),
);
const workflowTypeSchema = z.preprocess(
  normalizeWorkflowType,
  z.enum(['NODE', 'IMMEDIATE_CHILD', 'ALL_CHILD']),
);

const optionalWorkflowSearchQuerySchema = z.preprocess((value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return value;

  const query = value.trim();
  return query || undefined;
}, z.string().max(150, 'Query is too long').optional());

const optionalStringArraySchema = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [value];
  return value;
}, z.array(z.string().trim().min(1)).nullable().optional());

const optionalIntegerArraySchema = (
  options: { min: number; max: number; field: string },
) =>
  z.preprocess(
    (value) => {
      const normalize = (item: unknown) => {
        if (item === undefined || item === null || item === '') return null;
        return item;
      };

      if (Array.isArray(value)) return value.map(normalize).filter(Boolean);
      if (typeof value === 'string' && value.includes(',')) {
        return value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
      }

      const normalized = normalize(value);
      return normalized === null ? undefined : [normalized];
    },
    z
      .array(
        z.coerce
          .number()
          .int(`${options.field} must be an integer`)
          .min(
            options.min,
            `${options.field} must be between ${options.min} and ${options.max}`,
          )
          .max(
            options.max,
            `${options.field} must be between ${options.min} and ${options.max}`,
          ),
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

const workflowListPaginationSchema = z
  .object({
    statusType: requiredWorkflowListTypeSchema,
    query: optionalWorkflowSearchQuerySchema,
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
    nextCursor: optionalCursorTokenSchema('Next cursor').nullable().optional(),
    cursorId: optionalCursorTokenSchema('Cursor').nullable().optional(),
    topCursor: optionalCursorTokenSchema('Top cursor').nullable().optional(),
    ...paginationSchema,
  })
  .strict();

const workflowLevelFilterSchema = z
  .object({
    count: z.coerce
      .number()
      .int('Level count must be an integer')
      .min(1, 'Level count must be between 1 and 5')
      .max(5, 'Level count must be between 1 and 5'),
    approverType: z.preprocess(normalizeApproverType, approverTypeEnum),
  })
  .strict();

const workflowAppliedFilterSchema = z
  .object({
    nodeName: z
      .object({
        values: optionalStringArraySchema,
      })
      .strict()
      .nullable()
      .optional(),
    nodeType: optionalStringArraySchema,
    workflowType: optionalStringArraySchema,
    module: optionalStringArraySchema,
    subModule: optionalStringArraySchema,
    checker: optionalIntegerArraySchema({
      min: 1,
      max: 10,
      field: 'Checker count',
    }),
    levels: z.array(workflowLevelFilterSchema).nullable().optional(),
    workflowLevels: z.coerce
      .number()
      .int('Workflow levels must be an integer')
      .min(1, 'Workflow levels must be between 1 and 5')
      .max(5, 'Workflow levels must be between 1 and 5')
      .nullable()
      .optional(),
    approverType: z
      .array(z.preprocess(normalizeApproverType, approverTypeEnum))
      .nullable()
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
      .superRefine((value, context) => {
        if (value.dateRange !== 'CUSTOM') return;

        if (!value.fromDate || !value.toDate) {
          context.addIssue({
            code: 'custom',
            message:
              'fromDate and toDate are required when dateRange is CUSTOM',
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
    hasLinkedOrg: z
      .preprocess(
        (value) =>
          typeof value === 'string' ? value.trim().toLowerCase() : value,
        z.enum(['yes', 'no']).nullable().optional(),
      )
      .optional(),
  })
  .strict();

export const workflowOnboardingSchema = z
  .object({
    type: z.preprocess(normalizeRequestType, z.literal('initiate')).optional(),
    workflowType: workflowTypeSchema.default('NODE'),
    name: nameSchema('Workflow name')
      .min(2, 'Workflow name must be at least 2 characters')
      .max(100, 'Workflow name too long'),
    module: z.string().trim().min(1, 'Module is required'),
    nodePath: z.string().trim().min(1, 'Node path is required'),
    subModule: z.string().trim().min(1, 'Sub-module is required'),
    levels: levelsSchema.optional(),
    levelsHash: z.string().nullable().optional(),
  })
  .strict();

export const workflowModificationSchema = z
  .object({
    type: z.preprocess(
      normalizeRequestType,
      z.enum(['update', 'inactive', 'active', 'archive']),
    ),
    target: z
      .object({
        module: z.string().trim().min(1, 'Target module is required'),
        subModule: z.string().trim().min(1, 'Target sub-module is required'),
        nodePath: z.string().trim().min(1, 'Target node path is required'),
        levelsHash: z.string().trim().min(1, 'Target levels hash is required'),
      })
      .strict(),
    name: nameSchema('Workflow name')
      .min(2, 'Workflow name must be at least 2 characters')
      .max(100, 'Workflow name too long')
      .optional(),
    module: z.string().trim().min(1, 'Module is required').optional(),
    nodePath: z.string().trim().min(1, 'Node path is required').optional(),
    subModule: z.string().trim().min(1, 'Sub-module is required').optional(),
    workflowType: workflowTypeSchema.optional(),
    levels: levelsSchema.optional(),
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
      !value.name &&
      !value.module &&
      !value.nodePath &&
      !value.subModule &&
      !value.workflowType &&
      !value.levels
    ) {
      context.addIssue({
        code: 'custom',
        message: 'At least one changed workflow field is required',
        path: ['type'],
      });
    }
  });

export const workflowActionSchema = z
  .object({
    levelsHash: z.string().min(1, 'Levels hash is required'),
    action: z.enum(['approve', 'reject']),
    remark: z
      .string()
      .trim()
      .min(2, 'Please enter an approval remark with at least 2 characters')
      .max(500, 'Approval remark must be 500 characters or fewer'),
  })
  .strict();

export const workflowHistorySchema = z
  .object({
    id: z.string().min(1, 'Workflow id is required').optional(),
    levelsHash: z.string().min(1, 'Levels hash is required').optional(),
    module: z.string().trim().min(1, 'Module is required').optional(),
    subModule: z.string().trim().min(1, 'Sub-module is required').optional(),
    nodePath: z.string().trim().min(1, 'Node path is required').optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.levelsHash &&
      !value.id &&
      (!value.module || !value.subModule || !value.nodePath)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'module, subModule and nodePath are required when fetching workflow history by levelsHash',
        path: ['levelsHash'],
      });
    }
  });

export const workflowRequestsSchema = z
  .object({
    workflowId: z.string().uuid('Invalid workflow ID'),
  })
  .strict();

export const workflowListSchema = z
  .object({
    statusType: requiredWorkflowListTypeSchema.optional(),
    ...cursorPaginationFields,
    filter: z.boolean().optional(),
    pagination: workflowListPaginationSchema.optional(),
    applied: workflowAppliedFilterSchema.nullable().optional(),
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

export const workflowDetailsSchema = z
  .object({
    id: z.string().uuid('Workflow id is invalid').optional(),
    levelsHash: z.string().trim().min(1, 'Levels hash is required').optional(),
    module: z.string().trim().min(1, 'Module is required').optional(),
    subModule: z.string().trim().min(1, 'Sub-module is required').optional(),
    nodePath: z.string().trim().min(1, 'Node path is required').optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.id && !value.levelsHash) {
      context.addIssue({
        code: 'custom',
        message: 'id or levelsHash is required',
        path: ['id'],
      });
    }
  });
