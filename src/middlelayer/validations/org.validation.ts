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
import { nameSchema } from './common.validation';

const nodeTypeSchema = z.enum([
  'ROOT',
  'DIVISION',
  'DEPARTMENT',
  'TEAM',
  'PLANT',
  'LOCATION',
]);

const parentNodeSchema = z
  .object({
    nodeName: nameSchema('Node name').min(1, 'Node name is required'),
    nodePath: z.string().trim().min(1, 'Node path is required'),
  })
  .strict();

export const orgOnboardingSchema = z
  .object({
    type: z
      .preprocess(
        (value) =>
          typeof value === 'string' ? value.trim().toLowerCase() : value,
        z.literal('initiate'),
      )
      .optional(),
    newNodeName: nameSchema('New node name').min(
      1,
      'New node name is required',
    ),
    status:z.string().nullable().optional(),
    nodeType: nodeTypeSchema,
    parentNode: parentNodeSchema,
    levelsHash: z.string().nullable().optional(),
  })
  .strict();

export const orgModificationSchema = z
  .object({
    type: z.preprocess(
      (value) =>
        typeof value === 'string' ? value.trim().toLowerCase() : value,
      z.literal('update'),
    ),
    nodePath: z.string().trim().min(1, 'Node path is required'),
    status: z.preprocess(
      (value) =>
        typeof value === 'string' ? value.trim().toUpperCase() : value,
      z.literal('INACTIVE', {
        message: 'Only INACTIVE status is allowed for organization updates',
      }),
    ),
    levelsHash: z.string().nullable().optional(),
    remarks: z.string().trim().min(2).max(500).optional(),
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
    nodeName: nameSchema('Node name').optional(),
    nodePath: z.string().trim().optional(),
    pending: z.boolean().optional(),
    parentNodePath: z
      .string()
      .trim()
      .min(1, 'Parent node path is required')
      .optional(),
  })
  .strict()
  .superRefine(({ pending, parentNodePath }, ctx) => {
    if (pending && !parentNodePath) {
      ctx.addIssue({
        code: 'custom',
        path: ['parentNodePath'],
        message:
          'Parent node path is required for a pending organization request',
      });
    }
  });

export const orgFetchSchema = z.object({}).strict();
