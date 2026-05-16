import { z } from 'zod';

export const apiSpanTypeSchema = z.enum(['MIDDLELAYER', 'BACKEND', 'EXTERNAL']);

const optionalUuidSchema = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' ? value.trim() : value;
}, z.string().uuid().nullable());

export const monitoringApiSpanSchema = z
  .object({
    trackingId: z.string().trim().uuid(),
    subCount: z.string().trim().max(50).optional().nullable(),
    type: apiSpanTypeSchema,
    method: z
      .string()
      .trim()
      .min(1)
      .max(20)
      .transform((value) => value.toUpperCase()),
    url: z.string().trim().min(1).max(2048),
    statusCode: z.number().int().min(100).max(599).optional().nullable(),
    headers: z.unknown().optional().nullable(),
    reqBody: z.unknown().optional().nullable(),
    resBody: z.unknown().optional().nullable(),
    resHeaders: z.unknown().optional().nullable(),
    latency: z.number().int().min(0).optional().nullable(),
    ipAddress: z.string().trim().max(128).optional().nullable(),
    companyId: optionalUuidSchema.optional(),
    userId: optionalUuidSchema.optional(),
    startedAt: z.coerce.date().optional(),
    endedAt: z.coerce.date().optional().nullable(),
  })
  .strict();
