import { prisma } from '../../backend/lib/prisma';
import { AsyncLocalStorage } from 'async_hooks';
import { ApiSpanType } from '@prisma/client';
import crypto from 'crypto';

export interface TrackingContext {
  trackingId: string;
  companyId?: string;
  userId?: string;
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
  'proxy-authorization'
];

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
    if (SENSITIVE_FIELDS.includes(lowerKey)) {
      masked[key] = '********';
      
      // Add descriptive flags for headers
      if (lowerKey === 'cookie') masked['cookies_present'] = true;
      if (lowerKey === 'authorization') masked['auth_present'] = true;
      
    } else if (typeof masked[key] === 'object') {
      masked[key] = maskSensitiveData(masked[key]);
    }
  }
  return masked;
};

/**
 * API TRACKER UTILITY
 */
export class ApiTracker {
  private static getBackendUrl() {
    return process.env.BACKEND_URL || 'http://localhost:5001';
  }

  static async startTrace(data: {
    trackingId?: string;
    companyId?: string;
    userId?: string;
    entryMethod: string;
    entryUrl: string;
    serviceType: 'MIDDLELAYER' | 'BACKEND';
  }) {
    const trackingId = data.trackingId || crypto.randomUUID();
    const payload = {
      trackingId,
      companyId: data.companyId,
      userId: data.userId,
      entryMethod: data.entryMethod,
      entryUrl: data.entryUrl,
      startedAt: new Date(),
    };

    this.logTrace(payload, data.serviceType).catch(() => {});
    return trackingId;
  }

  private static async logTrace(payload: any, serviceType: string) {
    try {
      if (serviceType === 'BACKEND') {
        await prisma.apiTrace.create({ data: payload });
      } else {
        await fetch(`${this.getBackendUrl()}/internal/tracker/trace`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      }
    } catch (err) {}
  }

  static async endTrace(
    trackingId: string, 
    statusCode: number, 
    serviceType: 'MIDDLELAYER' | 'BACKEND',
    companyId?: string,
    userId?: string,
    totalLatency?: number
  ) {
    const endedAt = new Date();
    this.finalizeTrace(trackingId, statusCode, endedAt, serviceType, companyId, userId, totalLatency).catch(() => {});
  }

  private static async finalizeTrace(
    trackingId: string, 
    statusCode: number, 
    endedAt: Date, 
    serviceType: string,
    companyId?: string,
    userId?: string,
    totalLatency?: number
  ) {
    try {
      if (serviceType === 'BACKEND') {
        await prisma.apiTrace.updateMany({
          where: { trackingId },
          data: { 
            statusCode, 
            endedAt,
            ...(companyId && { companyId }),
            ...(userId && { userId }),
            ...(totalLatency && { totalLatency })
          }
        });
        
        // If latency wasn't provided, try to calculate it
        if (!totalLatency) {
          const trace = await prisma.apiTrace.findUnique({ where: { trackingId } });
          if (trace && trace.startedAt) {
            const calculatedLatency = endedAt.getTime() - trace.startedAt.getTime();
            await prisma.apiTrace.update({
              where: { trackingId },
              data: { totalLatency: calculatedLatency }
            });
          }
        }
      } else {
        await fetch(`${this.getBackendUrl()}/internal/tracker/trace`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trackingId, statusCode, endedAt, companyId, userId, totalLatency }),
        });
      }
    } catch (err) {}
  }

  static async createSpan(data: {
    type: ApiSpanType;
    method: string;
    url: string;
    parentSpanId?: string;
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

    const payload = {
      ...data,
      trackingId: context.trackingId,
      companyId: context.companyId,
      userId: context.userId,
      // Mask sensitive data before logging
      reqBody: maskSensitiveData(data.reqBody),
      resBody: maskSensitiveData(data.resBody),
      headers: maskSensitiveData(data.headers),
      startedAt: data.startedAt || new Date(),
      endedAt: data.endedAt || (data.latency ? new Date(Date.now()) : undefined),
    };

    this.logSpan(payload, context.serviceType).catch(() => {});
  }

  private static async logSpan(payload: any, serviceType: string) {
    try {
      if (serviceType === 'BACKEND') {
        await prisma.apiSpan.create({ data: payload });
      } else {
        await fetch(`${this.getBackendUrl()}/internal/tracker/span`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      }
    } catch (err) {}
  }

  /**
   * Updates the current request's context with identity info (late binding).
   */
  static setIdentity(data: { companyId?: string, userId?: string }) {
    const context = trackingStorage.getStore();
    if (context) {
      if (data.companyId) context.companyId = data.companyId;
      if (data.userId) context.userId = data.userId;
    }
  }
}
