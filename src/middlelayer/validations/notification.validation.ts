import { z } from 'zod';
import { optionalUuidSchema, paginationSchema } from './common.validation';

const normalizedFetchStatusSchema = z.preprocess(
  (value) => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    return typeof value === 'string' ? value.trim().toUpperCase() : value;
  },
  z.enum(['READ', 'UNREAD', 'HIDDEN', 'ALL']).optional().default('ALL'),
);

const normalizedReferenceTypeSchema = z.preprocess(
  (value) => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    return typeof value === 'string' ? value.trim().toUpperCase() : value;
  },
  z.enum(['USER', 'ORG', 'WORKFLOW', 'COMPANY']).optional(),
);

const normalizedDateRangeSchema = z.preprocess(
  (value) => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    if (typeof value !== 'string') {
      return value;
    }

    const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (normalized === '7DAYS') return '7_DAYS';
    if (normalized === '15DAYS') return '15_DAYS';
    if (normalized === '1MONTH') return '1_MONTH';
    return normalized;
  },
  z.enum(['ALL', '7_DAYS', '15_DAYS', '1_MONTH', 'CUSTOM']).optional().default('ALL'),
);

const normalizedDateStringSchema = z.preprocess(
  (value) => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    return typeof value === 'string' ? value.trim() : value;
  },
  z.string().min(1).optional(),
);

const normalizedReadStatusSchema = z.preprocess(
  (value) => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    return typeof value === 'string' ? value.trim().toUpperCase() : value;
  },
  z.enum(['READ', 'UNREAD', 'ARCHIVED']).optional(),
);

export const notificationFetchSchema = z
  .object({
    status: normalizedFetchStatusSchema,
    refType: normalizedReferenceTypeSchema,
    dateRange: normalizedDateRangeSchema,
    fromDate: normalizedDateStringSchema,
    toDate: normalizedDateStringSchema,
    cursorId: optionalUuidSchema('cursor ID'),
    cursor: optionalUuidSchema('cursor ID'),
    ...paginationSchema,
  })
  .strict()
  .refine(
    (data) =>
      data.dateRange !== 'CUSTOM' ||
      (Boolean(data.fromDate) && Boolean(data.toDate)),
    {
      message: 'fromDate and toDate are required when dateRange is CUSTOM',
      path: ['fromDate'],
    },
  )
  .refine(
    (data) => {
      if (data.dateRange !== 'CUSTOM' || !data.fromDate || !data.toDate) {
        return true;
      }

      const fromDate = new Date(data.fromDate);
      const toDate = new Date(data.toDate);

      return (
        !Number.isNaN(fromDate.getTime()) &&
        !Number.isNaN(toDate.getTime()) &&
        fromDate.getTime() <= toDate.getTime()
      );
    },
    {
      message: 'fromDate must be earlier than or equal to toDate',
      path: ['toDate'],
    },
  );

export const notificationReadSchema = z
  .object({
    notificationUserId: optionalUuidSchema('notification user ID'),
    notificationId: optionalUuidSchema('notification ID'),
    id: optionalUuidSchema('notification user ID'),
    status: normalizedReadStatusSchema,
  })
  .strict()
  .refine((data) => data.notificationUserId || data.id || data.notificationId, {
    message: 'notificationUserId or notificationId is required',
    path: ['notificationUserId'],
  });

export const notificationSettingsFetchSchema = z.object({}).strict();

export const notificationSettingsUpdateSchema = z
  .array(
    z
      .object({
        companyCode: z.string().trim().min(1, 'Company code is required'),
        settings: z
          .array(
            z
              .object({
                nodePath: z.string().trim().min(1, 'Node path is required'),
                module: z.enum(['USER', 'WORKFLOW', 'ORG']),
                isEnabled: z.boolean(),
                remarks: z.string().trim().min(1).nullable().optional(),
              })
              .strict(),
          )
          .min(1, 'At least one setting is required'),
      })
      .strict(),
  )
  .min(1, 'At least one company settings payload is required');
