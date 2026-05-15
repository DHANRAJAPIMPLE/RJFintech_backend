import { AppError } from '../../shared/middlewares/error.middleware';
import { internalPost } from './internal-fetch.util';

/**
 * Wrapper around internalPost that throws an AppError on failure.
 *
 * Extracts the repeated error-unwrapping pattern found across all middlelayer controllers:
 * ```
 * const { data, ok, status } = await internalPost(url, body);
 * if (!ok) {
 *   throw new AppError(data?.message || data?.error || 'Fallback message', status);
 * }
 * ```
 *
 * Usage:
 * ```
 * const data = await internalPostOrThrow(url, body, 'Fallback message');
 * ```
 *
 * The returned data is the parsed response body on success.
 * On failure, throws AppError with the same message/status extraction logic.
 */
export async function internalPostOrThrow<T = any>(
  url: string,
  body: Record<string, any>,
  fallbackMessage: string,
  fallbackStatus?: number,
): Promise<T> {
  const { data, ok, status } = await internalPost<T>(url, body);

  if (!ok) {
    const errorData = data as any;
    throw new AppError(
      errorData?.message || errorData?.error || fallbackMessage,
      fallbackStatus ?? status,
    );
  }

  return data;
}

/**
 * Variant that also checks for null/undefined data (used by fetch endpoints
 * where `!data` means "not found").
 *
 * Matches patterns like:
 * ```
 * if (!fetchOk || !request) {
 *   throw new AppError(request?.message || ... || 'Not found', 404);
 * }
 * ```
 */
export async function internalPostOrThrowNotNull<T = any>(
  url: string,
  body: Record<string, any>,
  fallbackMessage: string,
  fallbackStatus?: number,
): Promise<T> {
  const { data, ok, status } = await internalPost<T>(url, body);

  if (!ok || !data) {
    const errorData = data as any;
    throw new AppError(
      errorData?.message || errorData?.error || fallbackMessage,
      fallbackStatus ?? status ?? 404,
    );
  }

  return data;
}
