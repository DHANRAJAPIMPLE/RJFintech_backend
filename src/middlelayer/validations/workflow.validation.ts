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
import { cursorPaginationFields, nameSchema } from './common.validation';

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
const requiredWorkflowListTypeSchema = z.preprocess(
  normalizeRequestType,
  z.enum(['active', 'pending', 'inactive']),
);

export const workflowOnboardingSchema = z
  .object({
    type: z.preprocess(normalizeRequestType, z.literal('initiate')).optional(),
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
    type: z.preprocess(normalizeRequestType, z.enum(['update', 'inactive'])),
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
    levels: levelsSchema.optional(),
    levelsHash: z.string().nullable().optional(),
    remarks: z.string().trim().min(2).max(500).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.type === 'update' &&
      !value.name &&
      !value.module &&
      !value.nodePath &&
      !value.subModule &&
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
      .min(2, 'Remark too short')
      .max(500, 'Remark too long'),
  })
  .strict();

export const workflowHistorySchema = z
  .object({
    levelsHash: z.string().min(1, 'Levels hash is required').optional(),
    module: z.string().optional(),
    subModule: z.string().optional(),
    nodePath: z.string().optional(),
  })
  .strict();

export const workflowRequestsSchema = z
  .object({
    workflowId: z.string().uuid('Invalid workflow ID'),
  })
  .strict();

export const workflowListSchema = z
  .object({
    type: requiredWorkflowListTypeSchema,
    ...cursorPaginationFields,
  })
  .strict();
