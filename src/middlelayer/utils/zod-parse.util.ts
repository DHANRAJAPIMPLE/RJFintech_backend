import { ZodSchema } from 'zod';
import { AppError } from '../../shared/middlewares/error.middleware';

/**
 * Zod Parse Utility:
 * A wrapper around Zod's safeParse that standardizes how validation errors are handled.
 *
 * Why we use it:
 * - To convert complex Zod validation error objects into a flat, readable 'details' array.
 * - To throw a standardized 'AppError' that the global error middleware can easily process.
 * - It ensures that the frontend receives clear information about which specific fields failed validation.
 */
export function zodParse<T>(schema: ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues || (result.error as any).errors || [];
    const details = issues.map((e: any) => ({
      field: e.path.join('.') || 'root',
      message: e.message,
    }));
    const err = new AppError(
      `Validation failed: ${details[0]?.message}`,
      400,
    ) as any;
    err.details = details;
    throw err;
  }
  return result.data;
}
