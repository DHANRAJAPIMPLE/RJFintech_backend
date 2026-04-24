import { AppError } from '../../shared/middlewares/error.middleware';

/**
 * INTERNAL FETCH UTILITY:
 * Simplifies communication between the Middle Layer and the Backend DB Service.
 */
export const internalPost = async <T = any>(
  url: string,
  body?: Record<string, unknown>
): Promise<{ data: T; status: number; ok: boolean }> => {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = (await response.json()) as T;
    return { data, status: response.status, ok: response.ok };
  } catch (error) {
    throw new AppError('Backend service unreachable', 503);
  }
};
