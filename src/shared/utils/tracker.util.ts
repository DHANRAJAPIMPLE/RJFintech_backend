import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';

export type ApiSpanType = 'MIDDLELAYER' | 'BACKEND' | 'EXTERNAL';

export interface TrackingContext {
  trackingId: string;
  companyId?: string;
  userId?: string;
  clientIp?: string;
  serviceType: 'MIDDLELAYER' | 'BACKEND';
}

export const trackingStorage = new AsyncLocalStorage<TrackingContext>();

/**
 * Sensitive fields and headers that should never be logged in plain text.
 * Includes common sensitive body keys and standard security headers.
 */
const SENSITIVE_FIELDS = [
  // Body fields
  'password',
  'newpassword',
  'confirmpassword',
  'oldpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'secret',
  'otp',
  'creditcard',
  'cvv',
  // Headers (usually lowercase in Express)
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'proxy-authorization',
];

const PRESENCE_FLAG_FIELDS: Record<string, string> = {
  accesstoken: 'accessToken_present',
  refreshtoken: 'refreshToken_present',
  refershtoken: 'refreshToken_present',
  hashversion: 'hashVersion_present',
  versionhash: 'hashVersion_present',
};

const hasValue = (value: unknown) => {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
};

const hasCookie = (cookieHeader: unknown, cookieName: string) => {
  if (typeof cookieHeader !== 'string') return false;

  const normalizedCookieName = cookieName.toLowerCase();
  return cookieHeader
    .split(';')
    .some(
      (cookie) =>
        cookie.trim().split('=')[0]?.trim().toLowerCase() ===
        normalizedCookieName,
    );
};

/**
 * Recursively masks sensitive fields in an object.
 */
const maskSensitiveData = (data: any): any => {
  if (!data || typeof data !== 'object') return data;

  if (Array.isArray(data)) {
    return data.map(maskSensitiveData);
  }

  const masked: any = { ...data };
  for (const key in masked) {
    const lowerKey = key.toLowerCase();
    const presenceFlag = PRESENCE_FLAG_FIELDS[lowerKey];

    if (presenceFlag) {
      const present = hasValue(masked[key]);
      masked[key] = present;
      masked[presenceFlag] = present;
    } else if (SENSITIVE_FIELDS.includes(lowerKey)) {
      const originalValue = masked[key];
      masked[key] = '********';

      // Add descriptive flags for headers
      if (lowerKey === 'cookie') {
        masked['cookies_present'] = hasValue(originalValue);
        masked['accessToken_present'] = hasCookie(originalValue, 'accessToken');
        masked['refreshToken_present'] = hasCookie(
          originalValue,
          'refreshToken',
        );
        masked['hashVersion_present'] =
          hasCookie(originalValue, 'hashVersion') ||
          hasCookie(originalValue, 'versionHash');
      }
      if (lowerKey === 'authorization') masked['auth_present'] = true;
    } else if (typeof masked[key] === 'object') {
      masked[key] = maskSensitiveData(masked[key]);
    }
  }
  return masked;
};

/**
 * API TRACKER UTILITY
 *
 * Responsible for sending trace/span data to the backend tracker endpoints.
 * All methods are designed to be non-blocking and fault-tolerant — tracking
 * failures must NEVER break the actual business request flow.
 */
export class ApiTracker {
  private static getBackendUrl() {
    return process.env.BACKEND_URL || 'http://localhost:5001';
  }

  private static cleanString(value?: string | null) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  /**
   * Sends data to the backend tracker endpoint.
   * Returns true ONLY if the backend responded with a 2xx status.
   * Network errors and non-2xx responses return false.
   */
  private static async sendToTracker(
    path: string,
    method: 'POST' | 'PATCH',
    payload: Record<string, any>,
  ): Promise<boolean> {
    try {
      const response = await fetch(`${this.getBackendUrl()}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Sends with a single retry on failure. Used for critical operations
   * like trace creation and finalization where data loss is costly.
   */
  private static async sendWithRetry(
    path: string,
    method: 'POST' | 'PATCH',
    payload: Record<string, any>,
  ): Promise<boolean> {
    let ok = await this.sendToTracker(path, method, payload);
    if (!ok) {
      await new Promise((r) => setTimeout(r, 80));
      ok = await this.sendToTracker(path, method, payload);
    }
    return ok;
  }

  /**
   * Creates a new parent trace in the database.
   * This is awaited by the middleware to ensure the trace row exists
   * BEFORE any child spans reference it via trackingId FK.
   */
  static async startTrace(data: {
    trackingId?: string;
    companyId?: string;
    userId?: string;
    entryMethod: string;
    entryUrl: string;
    serviceType: 'MIDDLELAYER' | 'BACKEND';
  }): Promise<string> {
    const trackingId = data.trackingId || crypto.randomUUID();
    const companyId = this.cleanString(data.companyId);
    const userId = this.cleanString(data.userId);
    const payload = {
      trackingId,
      ...(companyId && { companyId }),
      ...(userId && { userId }),
      entryMethod: data.entryMethod,
      entryUrl: data.entryUrl,
      startedAt: new Date(),
    };

    const ok = await this.sendWithRetry(
      '/internal/tracker/trace/start',
      'POST',
      payload,
    );

    if (!ok) {
      console.warn(
        `[ApiTracker] Failed to persist trace ${trackingId} for ${data.entryMethod} ${data.entryUrl}`,
      );
    }

    return trackingId;
  }

  /**
   * Finalizes a trace with status code, latency, and identity.
   * Uses retry to ensure critical completion data is persisted.
   */
  static async endTrace(
    trackingId: string,
    statusCode: number,
    serviceType: 'MIDDLELAYER' | 'BACKEND',
    companyId?: string,
    userId?: string,
    totalLatency?: number,
  ) {
    const endedAt = new Date();
    this.finalizeTrace(
      trackingId,
      statusCode,
      endedAt,
      serviceType,
      companyId,
      userId,
      totalLatency,
    ).catch((e) => {
      console.warn(`[ApiTracker] Error finalizing trace ${trackingId}:`, e);
    });
  }

  private static async finalizeTrace(
    trackingId: string,
    statusCode: number,
    endedAt: Date,
    _serviceType: string,
    companyId?: string,
    userId?: string,
    totalLatency?: number,
  ) {
    const cleanCompanyId = this.cleanString(companyId);
    const cleanUserId = this.cleanString(userId);

    const payload = {
      trackingId,
      statusCode,
      endedAt,
      ...(cleanCompanyId && { companyId: cleanCompanyId }),
      ...(cleanUserId && { userId: cleanUserId }),
      ...(typeof totalLatency === 'number' && { totalLatency }),
    };

    const ok = await this.sendWithRetry(
      '/internal/tracker/trace/end',
      'PATCH',
      payload,
    );

    if (!ok) {
      console.warn(
        `[ApiTracker] Failed to finalize trace ${trackingId} (status=${statusCode}, latency=${totalLatency}ms)`,
      );
    }
  }

  /**
   * Records an API span (child of a trace).
   * Fire-and-forget with single retry — span loss is acceptable
   * but we log warnings for observability.
   */
  static async createSpan(data: {
    id?: string;
    type: ApiSpanType;
    method: string;
    url: string;
    parentSpanId?: string;
    companyId?: string;
    userId?: string;
    reqBody?: any;
    resBody?: any;
    statusCode?: number;
    latency?: number;
    headers?: any;
    startedAt?: Date;
    endedAt?: Date;
  }) {
    const context = trackingStorage.getStore();
    if (!context) return;

    const companyId =
      this.cleanString(data.companyId) || this.cleanString(context.companyId);
    const userId =
      this.cleanString(data.userId) || this.cleanString(context.userId);
    const headers =
      data.headers && typeof data.headers === 'object'
        ? {
            ...data.headers,
            ...(context.clientIp && {
              'x-client-ip': context.clientIp,
              'client-ip': context.clientIp,
            }),
          }
        : data.headers;

    const payload = {
      ...data,
      trackingId: context.trackingId,
      ...(companyId && { companyId }),
      ...(userId && { userId }),
      // Mask sensitive data before logging
      reqBody: maskSensitiveData(data.reqBody),
      resBody: maskSensitiveData(data.resBody),
      headers: maskSensitiveData(headers),
      startedAt: data.startedAt || new Date(),
      endedAt:
        data.endedAt || (data.latency ? new Date(Date.now()) : undefined),
    };

    const ok = await this.sendWithRetry(
      '/internal/tracker/span',
      'POST',
      payload,
    );

    if (!ok) {
      console.warn(
        `[ApiTracker] Failed to persist span for ${data.method} ${data.url} (trace=${context.trackingId})`,
      );
    }
  }

  /**
   * Updates the current request's context with identity info (late binding).
   */
  static setIdentity(data: {
    companyId?: string | null;
    userId?: string | null;
  }) {
    const context = trackingStorage.getStore();
    if (context) {
      const companyId = this.cleanString(data.companyId);
      const userId = this.cleanString(data.userId);

      if (companyId) context.companyId = companyId;
      if (userId) context.userId = userId;
    }
  }
}
