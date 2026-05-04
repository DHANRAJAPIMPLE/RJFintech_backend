import { AppError } from '../../shared/middlewares/error.middleware';

/**
 * Internal Fetch Utility:
 * Simplifies and standardizes service-to-service communication between the 
 * Middle Layer and the Backend Service.
 * 
 * Why we use it:
 * - To encapsulate common fetch logic (headers, body stringification, response parsing).
 * - To provide a consistent return type { data, status, ok }.
 * - To handle network failures gracefully by throwing a 503 'Service Unreachable' error.
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export const internalFetch = async <T = any>(
  url: string,
  method: HttpMethod = 'GET',
  body?: Record<string, any>,
): Promise<{ data: T; status: number; ok: boolean }> => {
  try {
    const options: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };

    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    // Some responses might not have a body (e.g., 204 No Content)
    let data: any = null;
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    return { data, status: response.status, ok: response.ok };
  } catch (_error) {
    throw new AppError('Backend service unreachable', 503);
  }
};

/**
 * Convenience wrapper for POST requests (backward compatibility and common use)
 */
export const internalPost = async <T = any>(
  url: string,
  body?: Record<string, any>,
) => internalFetch<T>(url, 'POST', body);
