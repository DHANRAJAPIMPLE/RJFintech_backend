import { z } from 'zod';
import { cursorPaginationFields } from './common.validation';

const trackingIdSchema = z.string().trim().uuid('Invalid tracking ID');

const monitoringQuerySchema = z.preprocess((value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();
  return trimmed === '' || ['null', 'undefined'].includes(trimmed.toLowerCase())
    ? undefined
    : trimmed;
}, z.string().max(150, 'Query is too long').optional());

const emptyToUndefined = (value: unknown) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();
  return trimmed === '' || ['null', 'undefined'].includes(trimmed.toLowerCase())
    ? undefined
    : trimmed;
};

const optionalDateStringSchema = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .refine((value) => !Number.isNaN(new Date(value).getTime()), {
      message: 'Invalid date format',
    })
    .optional(),
);

const monitoringDateRangeSchema = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value;

    const normalized = value
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, '');
    if (normalized === '7DAY') return '7DAYS';
    if (normalized === '15DAY') return '15DAYS';
    return normalized;
  },
  z.enum(['7DAYS', '15DAYS', '1MONTH', 'CUSTOM']).optional().nullable(),
);

const monitoringStatusSchema = z.preprocess(
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
  z.array(z.coerce.number().int().min(100).max(599)).optional(),
);

const responseSizeSortSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
  z.enum(['asc', 'desc']).optional().nullable(),
);

const responseSizeRangeSchema = z
  .union([
    z
      .string()
      .trim()
      .regex(/^\d+\s*-\s*\d+$/, 'Response size range must be like 0 - 100'),
    z
      .object({
        min: z.coerce
          .number()
          .int('Minimum response size must be an integer')
          .min(0, 'Minimum response size cannot be negative')
          .optional(),
        max: z.coerce
          .number()
          .int('Maximum response size must be an integer')
          .min(0, 'Maximum response size cannot be negative')
          .optional(),
      })
      .strict()
      .refine((value) => value.min !== undefined || value.max !== undefined, {
        message: 'Minimum or maximum response size is required',
      }),
  ])
  .nullable()
  .optional();

const subTrackSchema = z.preprocess(
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
  z.array(z.coerce.number().int().min(0)).optional(),
);

const monitoringAppliedFiltersSchema = z
  .object({
    date: monitoringDateRangeSchema,
    data: monitoringDateRangeSchema,
    dateRange: monitoringDateRangeSchema,
    fromDate: optionalDateStringSchema.nullable().optional(),
    formDate: optionalDateStringSchema.nullable().optional(),
    toDate: optionalDateStringSchema.nullable().optional(),
    status: monitoringStatusSchema,
    responseSize: z
      .union([responseSizeSortSchema, responseSizeRangeSchema])
      .optional()
      .nullable(),
    responseSizeSort: responseSizeSortSchema,
    responseSizeRange: responseSizeRangeSchema,
    subtrack: subTrackSchema,
    subTrack: subTrackSchema,
    query: monitoringQuerySchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const dateRange = value.dateRange ?? value.date ?? value.data;
    const fromDate = value.fromDate ?? value.formDate;

    if (dateRange === 'CUSTOM' && (!fromDate || !value.toDate)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'fromDate and toDate are required when dateRange is CUSTOM',
        path: ['fromDate'],
      });
      return;
    }

    if (!fromDate || !value.toDate) return;

    if (new Date(fromDate).getTime() > new Date(value.toDate).getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'fromDate must be earlier than or equal to toDate',
        path: ['toDate'],
      });
    }
  })
  .transform((value) => ({
    ...value,
    dateRange: value.dateRange ?? value.date ?? value.data,
    fromDate: value.fromDate ?? value.formDate,
    responseSizeSort:
      value.responseSizeSort ??
      (value.responseSize === 'asc' || value.responseSize === 'desc'
        ? value.responseSize
        : undefined),
    responseSizeRange:
      value.responseSizeRange ??
      (value.responseSize !== 'asc' && value.responseSize !== 'desc'
        ? value.responseSize
        : undefined),
    subTrack: value.subTrack ?? value.subtrack,
  }));

export const monitoringFetchAllSchema = z
  .object({
    ...cursorPaginationFields,
    filter: z.boolean().optional(),
    applied: monitoringAppliedFiltersSchema.nullable().optional(),
    date: monitoringDateRangeSchema,
    data: monitoringDateRangeSchema,
    dateRange: monitoringDateRangeSchema,
    fromDate: optionalDateStringSchema.nullable().optional(),
    formDate: optionalDateStringSchema.nullable().optional(),
    toDate: optionalDateStringSchema.nullable().optional(),
    status: monitoringStatusSchema,
    responseSize: z
      .union([responseSizeSortSchema, responseSizeRangeSchema])
      .optional()
      .nullable(),
    responseSizeSort: responseSizeSortSchema,
    responseSizeRange: responseSizeRangeSchema,
    subtrack: subTrackSchema,
    subTrack: subTrackSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const dateRange = value.dateRange ?? value.date ?? value.data;
    const fromDate = value.fromDate ?? value.formDate;

    if (dateRange === 'CUSTOM' && (!fromDate || !value.toDate)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'fromDate and toDate are required when dateRange is CUSTOM',
        path: ['fromDate'],
      });
      return;
    }

    if (!fromDate || !value.toDate) return;

    if (new Date(fromDate).getTime() > new Date(value.toDate).getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'fromDate must be earlier than or equal to toDate',
        path: ['toDate'],
      });
    }
  })
  .transform((value) => ({
    ...value,
    dateRange: value.dateRange ?? value.date ?? value.data,
    fromDate: value.fromDate ?? value.formDate,
    responseSizeSort:
      value.responseSizeSort ??
      (value.responseSize === 'asc' || value.responseSize === 'desc'
        ? value.responseSize
        : undefined),
    responseSizeRange:
      value.responseSizeRange ??
      (value.responseSize !== 'asc' && value.responseSize !== 'desc'
        ? value.responseSize
        : undefined),
    subTrack: value.subTrack ?? value.subtrack,
  }));

export const monitoringDetailsBodySchema = z
  .object({
    trackingId: trackingIdSchema.optional(),
    trackId: trackingIdSchema.optional(),
    // eslint-disable-next-line @typescript-eslint/naming-convention -- External request alias.
    tracking_id: trackingIdSchema.optional(),
  })
  .strict();

export const monitoringTrackingIdSchema = z
  .object({
    trackingId: trackingIdSchema,
  })
  .strict();
