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
 * API TRACKER UTILITY
 * Handles logging of API Traces and Spans.
 * Stateless and non-blocking.
 */
export class ApiTracker {
  private static getBackendUrl() {
    return process.env.BACKEND_URL || 'http://localhost:5001';
  }

  private static cleanId(value?: string | null) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  static setIdentity(data: {
    companyId?: string | null;
    userId?: string | null;
  }) {
    const context = trackingStorage.getStore();
    if (!context) return;

    const companyId = this.cleanId(data.companyId);
    const userId = this.cleanId(data.userId);

    if (companyId) {
      context.companyId = companyId;
    }

    if (userId) {
      context.userId = userId;
    }
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
    const companyId = this.cleanId(data.companyId);
    const userId = this.cleanId(data.userId);
    const payload = {
      trackingId,
      ...(companyId && { companyId }),
      ...(userId && { userId }),
      entryMethod: data.entryMethod,
      entryUrl: data.entryUrl,
      startedAt: new Date(),
    };

    await this.logTrace(payload, data.serviceType);
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
    } catch {
      return;
    }
  }

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
    ).catch(() => {});
  }

  private static async finalizeTrace(
    trackingId: string,
    statusCode: number,
    endedAt: Date,
    serviceType: string,
    companyId?: string,
    userId?: string,
    totalLatency?: number,
  ) {
    try {
      const cleanCompanyId = this.cleanId(companyId);
      const cleanUserId = this.cleanId(userId);

      if (serviceType === 'BACKEND') {
        const trace = await prisma.apiTrace.findUnique({
          where: { trackingId },
          select: { startedAt: true },
        });
        const resolvedTotalLatency =
          typeof totalLatency === 'number'
            ? totalLatency
            : trace?.startedAt
              ? Math.max(0, endedAt.getTime() - trace.startedAt.getTime())
              : undefined;

        await prisma.apiTrace.updateMany({
          where: { trackingId },
          data: {
            statusCode,
            endedAt,
            ...(typeof resolvedTotalLatency === 'number' && {
              totalLatency: resolvedTotalLatency,
            }),
            ...(cleanCompanyId && { companyId: cleanCompanyId }),
            ...(cleanUserId && { userId: cleanUserId }),
          },
        });
      } else {
        await fetch(`${this.getBackendUrl()}/internal/tracker/trace`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trackingId,
            statusCode,
            endedAt,
            companyId: cleanCompanyId,
            userId: cleanUserId,
            totalLatency,
          }),
        });
      }
    } catch {
      return;
    }
  }

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

    const id = this.cleanId(data.id);
    const parentSpanId = this.cleanId(data.parentSpanId);
    const companyId =
      this.cleanId(data.companyId) || this.cleanId(context.companyId);
    const userId = this.cleanId(data.userId) || this.cleanId(context.userId);

    const payload = {
      ...data,
      ...(id && { id }),
      trackingId: context.trackingId,
      ...(parentSpanId && { parentSpanId }),
      ...(companyId && { companyId }),
      ...(userId && { userId }),
      startedAt: data.startedAt || new Date(),
      endedAt:
        data.endedAt ||
        (typeof data.latency === 'number' ? new Date() : undefined),
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
    } catch {
      return;
    }
  }
}
