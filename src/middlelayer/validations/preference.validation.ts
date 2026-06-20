import { z } from 'zod';

export const userWorkflowPreferenceFetchSchema = z.object({}).strict();

export const userWorkflowPreferenceUpdateSchema = z
  .array(
    z
      .object({
        type: z.preprocess(
          (value) =>
            typeof value === 'string' ? value.trim().toUpperCase() : value,
          z.enum(['ADDED', 'REMOVED', 'ADDED/REMOVED']).transform((value) =>
            value === 'ADDED/REMOVED' ? 'ADDED' : value,
          ),
        ),
        module: z.preprocess(
          (value) =>
            typeof value === 'string' ? value.trim().toUpperCase() : value,
          z.enum(['USER', 'ORG', 'WORKFLOW']),
        ),
        nodePath: z.string().trim().min(1, 'Node path is required'),
        levelsHash: z.string().trim().min(1, 'Levels hash is required'),
        remarks: z.string().trim().min(1).max(500).optional(),
      })
      .strict(),
  )
  .min(1, 'At least one workflow preference update is required');
