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

const approverTypeEnum = z.enum([
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

export const workflowOnboardingSchema = z
  .object({
    companyCode: z.string().trim().min(1, 'Company code is required'),
    name: z
      .string()
      .trim()
      .min(2, 'Workflow name must be at least 2 characters'),
    module: z.string().trim().min(1, 'Module is required'),
    nodePath: z.string().trim().min(1, 'Node path is required'),
    subModule: z.string().trim().min(1, 'Sub-module is required'),
    levels: z
      .object({
        l1: levelSchema,
        l2: levelSchema,
        l3: levelSchema,
        l4: levelSchema,
        l5: levelSchema,
      })
      .optional(),
      levelsHash: z.string().nullable().optional(),
  })
  .strict();

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
  })
  .strict();

export const companyCodeOnlySchema = z
  .object({
    companyCode: z.string().trim().min(1, 'Company code is required'),
  })
  .strict();

export const workflowRequestsSchema = z
  .object({
    workflowId: z.string().uuid('Invalid workflow ID'),
  })
  .strict();
