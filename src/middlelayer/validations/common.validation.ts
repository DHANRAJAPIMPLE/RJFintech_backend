import { z } from 'zod';

const nameRegex = /^[A-Za-z .'-]*$/;

const emptyToUndefined = (value: unknown) => {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }

  return value;
};

export const nameSchema = (fieldName = 'Name') =>
  z
    .string()
    .trim()
    .regex(
      nameRegex,
      `${fieldName} can only contain letters, spaces, dots, hyphens, and apostrophes`,
    );

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Invalid email format')
  .max(150, 'Email is too long');

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(64, 'Password cannot exceed 64 characters')
  .regex(/[A-Z]/, 'Must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Must contain at least one number')
  .regex(/[^A-Za-z0-9]/, 'Must contain at least one special character');

export const optionalUuidSchema = (fieldName = 'ID') =>
  z.preprocess(
    emptyToUndefined,
    z.string().uuid(`Invalid ${fieldName}`).optional(),
  );

export const optionalTrimmedStringSchema = (fieldName = 'Value') =>
  z.preprocess(
    emptyToUndefined,
    z.string().min(1, `${fieldName} is required`).optional(),
  );

export const optionalCursorTokenSchema = (fieldName = 'Cursor') =>
  z.preprocess(
    emptyToUndefined,
    z
      .string()
      .min(1, `${fieldName} is required`)
      .max(2048, `${fieldName} is too long`)
      .optional(),
  );

export const numberWithDefaultSchema = ({
  fieldName,
  defaultValue,
  min,
  max,
}: {
  fieldName: string;
  defaultValue: number;
  min: number;
  max?: number;
}) => {
  let schema = z.coerce
    .number()
    .int(`${fieldName} must be an integer`)
    .min(min, `${fieldName} must be greater than or equal to ${min}`);

  if (max !== undefined) {
    schema = schema.max(max, `${fieldName} cannot exceed ${max}`);
  }

  return z.preprocess(
    emptyToUndefined,
    schema.optional().default(defaultValue),
  );
};

export const paginationSchema = {
  offset: numberWithDefaultSchema({
    fieldName: 'Offset',
    defaultValue: 0,
    min: 0,
  }),
  limit: numberWithDefaultSchema({
    fieldName: 'Limit',
    defaultValue: 10,
    min: 1,
    max: 100,
  }),
};
