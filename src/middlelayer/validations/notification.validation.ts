import { z } from 'zod';
import { optionalUuidSchema, paginationSchema } from './common.validation';

const normalizedFetchStatusSchema = z.preprocess(
  (value) => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    return typeof value === 'string' ? value.trim().toUpperCase() : value;
  },
  z.enum(['READ', 'UNREAD', 'ALL']).optional().default('ALL'),
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
    cursorId: optionalUuidSchema('cursor ID'),
    cursor: optionalUuidSchema('cursor ID'),
    ...paginationSchema,
  })
  .strict();

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
