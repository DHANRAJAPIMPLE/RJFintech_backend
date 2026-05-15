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
 *
 * Tracking Integration:
 * - Propagates track-id, company-id, user-id, parent-span-id headers to the backend.
 * - Records each call as a MIDDLELAYER span for full request traceability.
 * - The backend will record its own BACKEND span via its tracker middleware.
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
  const clientIp = cleanString(context?.clientIp);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (context && (companyId || userId)) {
    ApiTracker.setIdentity({ companyId, userId });
  }

  if (context) {
    headers['track-id'] = context.trackingId;

    if (companyId) {
      headers['company-id'] = companyId;
    }

    if (userId) {
      headers['user-id'] = userId;
    }

    if (spanId) {
      headers['parent-span-id'] = spanId;
    }

    if (clientIp) {
      headers['x-client-ip'] = clientIp;
      headers['client-ip'] = clientIp;
    }
  }

  try {
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

    // Parse URL for consistent relative path tracing
    let parsedUrl = url;
    try {
      const urlObj = new URL(url);
      parsedUrl = urlObj.pathname + urlObj.search;
    } catch (e) {
      // fallback to original
    }

    // Record this call as a MIDDLELAYER span
    if (context) {
      ApiTracker.createSpan({
        id: spanId,
        type: 'MIDDLELAYER',
        method,
        url: parsedUrl,
        parentSpanId: context.parentSpanId || context.trackingId,
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
    let parsedUrl = url;
    try {
      const urlObj = new URL(url);
      parsedUrl = urlObj.pathname + urlObj.search;
    } catch (e) {}

    if (context) {
      ApiTracker.createSpan({
        id: spanId,
        type: 'MIDDLELAYER',
        method,
        url: parsedUrl,
        parentSpanId: context.parentSpanId || context.trackingId,
        statusCode: 503,
        latency,
        companyId,
        userId,
        reqBody: body,
        resBody: { error: 'Backend service unreachable' },
        headers,
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
