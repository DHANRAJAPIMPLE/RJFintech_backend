import { AppError } from '../../shared/middlewares/error.middleware';
import crypto from 'crypto';

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
import { trackingStorage, ApiTracker } from '../../shared/utils/tracker.util';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

const cleanString = (value: unknown) => {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const identityFromBody = (body?: Record<string, any>) => {
  return {
    companyId:
      cleanString(body?.companyId) ||
      cleanString(body?.company_id) ||
      cleanString(body?.data?.companyId) ||
      cleanString(body?.data?.company_id),
    userId: cleanString(body?.userId) || cleanString(body?.user_id),
  };
};

export const internalFetch = async <T = any>(
  url: string,
  method: HttpMethod = 'GET',
  body?: Record<string, any>,
): Promise<{ data: T; status: number; ok: boolean }> => {
  const context = trackingStorage.getStore();
  const startTime = Date.now();
  const spanId = context ? crypto.randomUUID() : undefined;
  const bodyIdentity = identityFromBody(body);
  const companyId = cleanString(context?.companyId) || bodyIdentity.companyId;
  const userId = cleanString(context?.userId) || bodyIdentity.userId;

  if (context && (companyId || userId)) {
    ApiTracker.setIdentity({ companyId, userId });
  }

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (context) {
      headers['tracking-id'] = context.trackingId;

      if (companyId) {
        headers['company-id'] = companyId;
      }

      if (userId) {
        headers['user-id'] = userId;
      }

      if (spanId) {
        headers['parent-span-id'] = spanId;
      }
    }

    const options: RequestInit = {
      method,
      headers,
    };

    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    const latency = Date.now() - startTime;

    // Some responses might not have a body (e.g., 204 No Content)
    let data: any = null;
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    // Record this call as a span
    if (context) {
      ApiTracker.createSpan({
        id: spanId,
        type: 'MIDDLELAYER', // From middlelayer perspective, backend is middlelayer internal call
        method,
        url,
        statusCode: response.status,
        latency,
        companyId,
        userId,
        reqBody: body,
        resBody: data,
        headers: options.headers,
        startedAt: new Date(startTime),
        endedAt: new Date(),
      });
    }

    return { data, status: response.status, ok: response.ok };
  } catch (_error) {
    const latency = Date.now() - startTime;
    if (context) {
      ApiTracker.createSpan({
        id: spanId,
        type: 'MIDDLELAYER',
        method,
        url,
        statusCode: 503,
        latency,
        companyId,
        userId,
        reqBody: body,
        resBody: { error: 'Backend service unreachable' },
        startedAt: new Date(startTime),
        endedAt: new Date(),
      });
    }
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
