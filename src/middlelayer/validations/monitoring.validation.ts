import { z } from 'zod';
import { cursorPaginationFields } from './common.validation';

const trackingIdSchema = z.string().trim().uuid('Invalid tracking ID');

export const monitoringFetchAllSchema = z
  .object({
    ...cursorPaginationFields,
  })
  .strict();

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
