import { z } from 'zod';

const normalizedHistoryTypeSchema = z.preprocess(
  (value) => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    return typeof value === 'string' ? value.trim().toUpperCase() : value;
  },
  z.enum(['USER', 'ORG', 'WORKFLOW']),
);

export const historyDetailSchema = z
  .object({
    id: z.string().trim().min(1, 'History ID is required'),
    type: normalizedHistoryTypeSchema,
  })
  .strict();
