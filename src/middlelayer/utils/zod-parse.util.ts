import { ZodSchema } from 'zod';
import { AppError } from '../../shared/middlewares/error.middleware';

/**
 * Parses and validates `data` against the provided Zod `schema`.
 * Throws an `AppError` with status 400 and a readable `details` field
 * if validation fails, so the global error middleware forwards it to
 * the frontend in a consistent shape:
 *
 *   { status: 'error', statusCode: 400, message: 'Validation failed', details: [...] }
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
