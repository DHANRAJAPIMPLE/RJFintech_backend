import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../lib/prisma';

const cleanString = (value: unknown) => {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const cleanDate = (value: unknown) => {
  if (!value) return undefined;

  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const cleanNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  if (typeof value === 'string' && value.trim()) {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }

  return undefined;
};

/**
 * TRACKER DB CONTROLLER:
 * Handles incoming logging requests from the Middle Layer.
 * This ensures that only the Backend Service interacts with the ApiTrace/ApiSpan tables.
 */
export class TrackerDbController {
  static async createTrace(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        trackingId,
        companyId,
        userId,
        entryMethod,
        entryUrl,
        startedAt,
      } = req.body;
      const cleanTrackingId = cleanString(trackingId);
      const cleanCompanyId = cleanString(companyId);
      const cleanUserId = cleanString(userId);
      const cleanEntryMethod = cleanString(entryMethod) || 'UNKNOWN';
      const cleanEntryUrl = cleanString(entryUrl) || 'UNKNOWN';
      const cleanStartedAt = cleanDate(startedAt);

      if (!cleanTrackingId) {
        return res.status(400).json({ error: 'trackingId is required' });
      }

      let trace;
      try {
        trace = await prisma.apiTrace.upsert({
          where: { trackingId: cleanTrackingId },
          create: {
            trackingId: cleanTrackingId,
            ...(cleanCompanyId && { companyId: cleanCompanyId }),
            ...(cleanUserId && { userId: cleanUserId }),
            entryMethod: cleanEntryMethod,
            entryUrl: cleanEntryUrl,
            startedAt: cleanStartedAt || new Date(),
          },
          update: {
            ...(cleanCompanyId && { companyId: cleanCompanyId }),
            ...(cleanUserId && { userId: cleanUserId }),
            entryMethod: cleanEntryMethod,
            entryUrl: cleanEntryUrl,
            ...(cleanStartedAt && { startedAt: cleanStartedAt }),
          },
        });
      } catch (error: any) {
        if (error.code === 'P2002') {
          // Record already exists, fetch it so we can return it
          trace = await prisma.apiTrace.findUnique({ where: { trackingId: cleanTrackingId } });
        } else {
          throw error;
        }
      }

      res.status(201).json(trace);
    } catch (error) {
      next(error);
    }
  }

  static async updateTrace(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        trackingId,
        statusCode,
        endedAt,
        totalLatency,
        companyId,
        userId,
      } = req.body;
      const cleanTrackingId = cleanString(trackingId);
      const endedAtDate = cleanDate(endedAt) || new Date();
      const cleanStatusCode = cleanNumber(statusCode);
      const cleanCompanyId = cleanString(companyId);
      const cleanUserId = cleanString(userId);

      if (!cleanTrackingId) {
        return res.status(400).json({ error: 'trackingId is required' });
      }

      const trace = await prisma.apiTrace.findUnique({
        where: { trackingId: cleanTrackingId },
        select: { startedAt: true },
      });
      const resolvedTotalLatency =
        cleanNumber(totalLatency) ??
        (trace?.startedAt
          ? Math.max(0, endedAtDate.getTime() - trace.startedAt.getTime())
          : undefined);

      let updatedTrace;
      try {
        updatedTrace = await prisma.apiTrace.upsert({
          where: { trackingId: cleanTrackingId },
          create: {
            trackingId: cleanTrackingId,
            entryMethod: 'UNKNOWN',
            entryUrl: 'UNKNOWN',
            startedAt: endedAtDate,
            ...(typeof cleanStatusCode === 'number' && {
              statusCode: cleanStatusCode,
            }),
            endedAt: endedAtDate,
            ...(typeof resolvedTotalLatency === 'number' && {
              totalLatency: resolvedTotalLatency,
            }),
            ...(cleanCompanyId && { companyId: cleanCompanyId }),
            ...(cleanUserId && { userId: cleanUserId }),
          },
          update: {
            ...(typeof cleanStatusCode === 'number' && {
              statusCode: cleanStatusCode,
            }),
            endedAt: endedAtDate,
            ...(typeof resolvedTotalLatency === 'number' && {
              totalLatency: resolvedTotalLatency,
            }),
            ...(cleanCompanyId && { companyId: cleanCompanyId }),
            ...(cleanUserId && { userId: cleanUserId }),
          },
        });
      } catch (error: any) {
        if (error.code === 'P2002') {
          updatedTrace = await prisma.apiTrace.findUnique({ where: { trackingId: cleanTrackingId } });
        } else {
          throw error;
        }
      }

      res.status(200).json({ success: true, updated: 1, trace: updatedTrace });
    } catch (error) {
      next(error);
    }
  }

  static async createSpan(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        id,
        trackingId,
        companyId,
        userId,
        parentSpanId,
        parentId,
        type,
        method,
        url,
        statusCode,
        headers,
        reqBody,
        resBody,
        latency,
        startedAt,
        endedAt,
      } = req.body;
      const cleanId = cleanString(id);
      const cleanTrackingId = cleanString(trackingId);
      const cleanCompanyId = cleanString(companyId);
      const cleanUserId = cleanString(userId);
      const cleanMethod = cleanString(method) || 'UNKNOWN';
      const cleanUrl = cleanString(url) || 'UNKNOWN';
      const cleanStatusCode = cleanNumber(statusCode);
      const cleanLatency = cleanNumber(latency);
      const cleanStartedAt = cleanDate(startedAt) || new Date();
      const cleanEndedAt = cleanDate(endedAt);
      const cleanParentSpanId =
        cleanString(parentSpanId) ||
        cleanString(parentId) ||
        cleanString(req.body['parent_id']);

      if (!cleanTrackingId) {
        return res.status(400).json({ error: 'trackingId is required' });
      }

      try {
        await prisma.apiTrace.upsert({
          where: { trackingId: cleanTrackingId },
          create: {
            trackingId: cleanTrackingId,
            ...(cleanCompanyId && { companyId: cleanCompanyId }),
            ...(cleanUserId && { userId: cleanUserId }),
            entryMethod: cleanMethod,
            entryUrl: cleanUrl,
            startedAt: cleanStartedAt,
          },
          update: {
            ...(cleanCompanyId && { companyId: cleanCompanyId }),
            ...(cleanUserId && { userId: cleanUserId }),
          },
        });
      } catch (upsertError: any) {
        // P2002 is the code for Unique constraint failed. 
        // If we hit this, it means another span or the trace start just created it.
        if (upsertError.code !== 'P2002') {
          console.error('[Tracker] Trace upsert failed:', upsertError.message);
        }
      }

      const span = await prisma.apiSpan.create({
        data: {
          ...(cleanId && { id: cleanId }),
          trackingId: cleanTrackingId,
          ...(cleanCompanyId && { companyId: cleanCompanyId }),
          ...(cleanUserId && { userId: cleanUserId }),
          ...(cleanParentSpanId && { parentSpanId: cleanParentSpanId }),
          type,
          method: cleanMethod,
          url: cleanUrl,
          ...(typeof cleanStatusCode === 'number' && {
            statusCode: cleanStatusCode,
          }),
          headers,
          reqBody,
          resBody,
          ...(typeof cleanLatency === 'number' && { latency: cleanLatency }),
          startedAt: cleanStartedAt,
          endedAt: cleanEndedAt,
        },
      });

      res.status(201).json(span);
    } catch (error) {
      next(error);
    }
  }
}
