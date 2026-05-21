import { z } from 'zod';
import { numberWithDefaultSchema } from './common.validation';

const trackingIdSchema = z.string().trim().uuid('Invalid tracking ID');

export const monitoringFetchAllSchema = z
  .object({
    limit: numberWithDefaultSchema({
      fieldName: 'Limit',
      defaultValue: 100,
      min: 1,
      max: 500,
    }),
    offset: numberWithDefaultSchema({
      fieldName: 'Offset',
      defaultValue: 0,
      min: 0,
    }),
  })
  .strict();

export const monitoringDetailsBodySchema = z
  .object({
    trackingId: trackingIdSchema.optional(),
    trackId: trackingIdSchema.optional(),
    tracking_id: trackingIdSchema.optional(),
  })
  .strict();

export const monitoringTrackingIdSchema = z
  .object({
    trackingId: trackingIdSchema,
  })
  .strict();
