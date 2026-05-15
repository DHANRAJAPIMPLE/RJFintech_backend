import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../lib/prisma';

const getHeaderValue = (headers: unknown, names: string[]) => {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return null;
  }

  const headerMap = headers as Record<string, unknown>;
  const matchedKey = Object.keys(headerMap).find((key) =>
    names.includes(key.toLowerCase()),
  );
  const value = matchedKey ? headerMap[matchedKey] : null;

  if (Array.isArray(value)) {
    const firstValue = value.find(
      (item): item is string => typeof item === 'string' && item.trim() !== '',
    );
    return firstValue || null;
  }

  return typeof value === 'string' && value.trim() ? value : null;
};

const getClientIpFromSpans = (
  spans: Array<{ headers: unknown }>,
): string | null => {
  for (const span of spans) {
    const clientIp = getHeaderValue(span.headers, [
      'x-client-ip',
      'client-ip',
      'x-forwarded-for',
    ]);

    if (clientIp) return clientIp.split(',')[0]?.trim() || clientIp;
  }

  return null;
};

/**
 * MONITORING DB CONTROLLER:
 * Provides analytics and drill-down data for SAAS Admins.
 */
export class MonitoringDbController {
  /**
   * Fetches all API traces with company and user details,
   * including a count of how many internal spans each trace generated.
   */
  static async fetchTraces(req: Request, res: Response, next: NextFunction) {
    try {
      const traces = await prisma.apiTrace.findMany({
        orderBy: { startedAt: 'desc' },
        include: {
          company: {
            select: { legalName: true, companyCode: true },
          },
          user: {
            select: { name: true, email: true },
          },
          spans: {
            select: { type: true, headers: true },
          },
          _count: {
            select: { spans: true },
          },
        },
        take: 100, // Safety limit
      });

      // Format response as requested
      const formatted = traces.map((t) => {
        const backendSpanCount = t.spans.filter(
          (span) => span.type === 'BACKEND',
        ).length;
        const clientIp = getClientIpFromSpans(t.spans);

        return {
          id: t.id,
          trackingId: t.trackingId,
          companyName: t.company?.legalName || 'N/A',
          companyCode: t.company?.companyCode || 'N/A',
          userName: t.user?.name || 'N/A',
          userEmail: t.user?.email || 'N/A',
          timestamp: t.startedAt,
          method: t.entryMethod,
          endpoint: t.entryUrl,
          statusCode: t.statusCode,
          latency: t.totalLatency,
          clientIp,
          spanCount: backendSpanCount,
          totalSpanCount: t._count.spans,
        };
      });

      res.status(200).json(formatted);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Fetches the complete lifecycle of a single request.
   */
  static async getTraceDetails(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { id } = req.body;

      if (!id) {
        return res.status(400).json({ error: 'id is required' });
      }

      // 1. Get the main trace by primary ID
      const trace = await prisma.apiTrace.findUnique({
        where: { id },
        include: {
          spans: {
            orderBy: { startedAt: 'asc' },
          },
        },
      });

      if (!trace) {
        return res.status(404).json({ error: 'Trace not found' });
      }

      const clientIp = getClientIpFromSpans(trace.spans);

      res.status(200).json({
        mainRequest: {
          trackingId: trace.trackingId,
          method: trace.entryMethod,
          url: trace.entryUrl,
          statusCode: trace.statusCode,
          latency: trace.totalLatency,
          clientIp,
          startedAt: trace.startedAt,
          endedAt: trace.endedAt,
        },
        childSpans: trace.spans.map((s) => ({
          id: s.id,
          parentSpanId: s.parentSpanId,
          type: s.type,
          method: s.method,
          url: s.url,
          statusCode: s.statusCode,
          latency: s.latency,
          reqBody: s.reqBody,
          resBody: s.resBody,
          headers: s.headers,
          startedAt: s.startedAt,
        })),
      });
    } catch (error) {
      next(error);
    }
  }
}
