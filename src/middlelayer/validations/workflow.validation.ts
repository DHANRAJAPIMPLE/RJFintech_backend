import { z } from 'zod';

const approverTypeEnum = z.enum([
  'REPORTING_MANAGER',
  'NODE_APPROVER',
  'HIERARCHY_APPROVER',
]);
const approvalTypeEnum = z.enum(['AND', 'OR']);

const levelSchema = z
  .object({
    approver1: approverTypeEnum.nullable().optional(),
    type: approvalTypeEnum.nullable().optional(),
    approver2: approverTypeEnum.nullable().optional(),
  })
  .optional()
  .nullable();

export const workflowOnboardingSchema = z
  .object({
    companyCode: z.string().trim().min(1, 'Company code is required'),
    name: z
      .string()
      .trim()
      .min(2, 'Workflow name must be at least 2 characters'),
    alias: z.string().trim().min(2, 'Alias must be at least 2 characters'),
    module: z.string().trim().min(1, 'Module is required'),
    subModule: z.string().trim().min(1, 'Sub-module is required'),
    levels: z.object({
      l1: levelSchema,
      l2: levelSchema,
      l3: levelSchema,
      l4: levelSchema,
      l5: levelSchema,
    }),
  })
  .strict();

export const workflowActionSchema = z
  .object({
    id: z.string().uuid('Invalid workflow request ID'),
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
    alias: z.string().trim().min(1, 'Alias is required'),
  })
  .strict();

export const companyCodeOnlySchema = z
  .object({
    companyCode: z.string().trim().min(1, 'Company code is required'),
  })
  .strict();
