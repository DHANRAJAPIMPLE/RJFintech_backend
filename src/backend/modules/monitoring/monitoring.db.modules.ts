import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../lib/prisma';

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
            select: { legalName: true, companyCode: true }
          },
          user: {
            select: { name: true, email: true }
          },
          _count: {
            select: { spans: true }
          }
        },
        take: 100 // Safety limit
      });

      // Format response as requested
      const formatted = traces.map(t => ({
        id: t.id,
        trackingId: t.trackingId,
        companyName: t.company?.legalName || 'N/A',
        companyCode: t.company?.companyCode || 'N/A',
        userName: t.user?.name || 'N/A',
        userEmail: t.user?.email || 'N/A',
        timestamp: t.startedAt,
        method: t.entryMethod,
        endpoint: t.entryUrl,
        spanCount: t._count.spans
      }));

      res.status(200).json(formatted);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Fetches the complete lifecycle of a single request.
   */
  static async getTraceDetails(req: Request, res: Response, next: NextFunction) {
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
            orderBy: { startedAt: 'asc' }
          }
        }
      });

      if (!trace) {
        return res.status(404).json({ error: 'Trace not found' });
      }

      res.status(200).json({
        mainRequest: {
          trackingId: trace.trackingId,
          method: trace.entryMethod,
          url: trace.entryUrl,
          status: trace.statusCode,
          latency: trace.totalLatency,
          startedAt: trace.startedAt,
          endedAt: trace.endedAt
        },
        childSpans: trace.spans.map(s => ({
          type: s.type,
          method: s.method,
          url: s.url,
          status: s.statusCode,
          latency: s.latency,
          reqBody: s.reqBody,
          resBody: s.resBody,
          headers: s.headers,
          startedAt: s.startedAt
        }))
      });
    } catch (error) {
      next(error);
    }
  }
}
