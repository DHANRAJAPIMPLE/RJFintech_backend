import { z } from 'zod';
import { optionalUuidSchema } from './common.validation';
import {
  TEMPLATE_EVENTS,
  TEMPLATE_MODULES,
} from '../../shared/utils/template.util';

const normalizedTemplateModuleSchema = z.preprocess(
  (value) =>
    typeof value === 'string'
      ? value.trim().toUpperCase().replace(/[\s-]+/g, '_')
      : value,
  z.enum(TEMPLATE_MODULES),
);

const normalizedTemplateEventSchema = z.preprocess(
  (value) =>
    typeof value === 'string'
      ? value.trim().toUpperCase().replace(/[\s-]+/g, '_')
      : value,
  z.enum(TEMPLATE_EVENTS),
);

export const templateUpsertSchema = z
  .object({
    userId: optionalUuidSchema('user ID'),
    companyId: optionalUuidSchema('company ID'),
    templates: z
      .array(
        z
          .object({
            module: normalizedTemplateModuleSchema,
            event: normalizedTemplateEventSchema,
            isEnabled: z.boolean(),
          })
          .strict(),
      )
      .min(1, 'At least one template entry is required'),
  })
  .strict();

export const templateFetchSchema = z
  .object({
    userId: optionalUuidSchema('user ID'),
    companyId: optionalUuidSchema('company ID'),
  })
  .strict();
