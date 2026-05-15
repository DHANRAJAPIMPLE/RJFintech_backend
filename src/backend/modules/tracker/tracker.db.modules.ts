import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../lib/prisma';

const cleanString = (value: unknown) => {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const isUUID = (value: string) => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value);
};

const cleanId = (value: unknown) => {
  const str = cleanString(value);
  return str && isUUID(str) ? str : undefined;
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
 */
export class TrackerDbController {
  static async createTrace(req: Request, res: Response, next: NextFunction) {
    try {
      const { trackingId, companyId, userId, entryMethod, entryUrl, startedAt } = req.body;
      const cleanTrackingId = cleanString(trackingId);
      
      // Look in body first, then headers
      const validCompanyId = cleanId(companyId || req.headers['company-id']);
      const validUserId = cleanId(userId || req.headers['user-id']);
      
      const cleanEntryMethod = cleanString(entryMethod) || 'UNKNOWN';
      const cleanEntryUrl = cleanString(entryUrl) || 'UNKNOWN';
      const cleanStartedAt = cleanDate(startedAt);

      if (!cleanTrackingId) return res.status(400).json({ error: 'trackingId is required' });

      let trace;
      try {
        trace = await prisma.apiTrace.upsert({
          where: { trackingId: cleanTrackingId },
          create: {
            trackingId: cleanTrackingId,
            ...(validCompanyId && { companyId: validCompanyId }),
            ...(validUserId && { userId: validUserId }),
            entryMethod: cleanEntryMethod,
            entryUrl: cleanEntryUrl,
            startedAt: cleanStartedAt || new Date(),
          },
          update: {
            ...(validCompanyId && { companyId: validCompanyId }),
            ...(validUserId && { userId: validUserId }),
            entryMethod: cleanEntryMethod,
            entryUrl: cleanEntryUrl,
          },
        });
      } catch (error: any) {
        if (error.code === 'P2003') {
          trace = await prisma.apiTrace.upsert({
            where: { trackingId: cleanTrackingId },
            create: { trackingId: cleanTrackingId, entryMethod: cleanEntryMethod, entryUrl: cleanEntryUrl, startedAt: cleanStartedAt || new Date() },
            update: { entryMethod: cleanEntryMethod, entryUrl: cleanEntryUrl }
          });
        } else if (error.code === 'P2002') {
          trace = await prisma.apiTrace.findUnique({ where: { trackingId: cleanTrackingId } });
        } else throw error;
      }

      res.status(201).json(trace);
    } catch (error) { next(error); }
  }

  static async updateTrace(req: Request, res: Response, next: NextFunction) {
    try {
      const { trackingId, statusCode, endedAt, totalLatency, companyId, userId } = req.body;
      const cleanTrackingId = cleanString(trackingId);
      if (!cleanTrackingId) return res.status(400).json({ error: 'trackingId is required' });

      const endedAtDate = cleanDate(endedAt) || new Date();
      const cleanStatusCode = cleanNumber(statusCode);
      const validCompanyId = cleanId(companyId || req.headers['company-id']);
      const validUserId = cleanId(userId || req.headers['user-id']);

      const trace = await prisma.apiTrace.findUnique({ where: { trackingId: cleanTrackingId }, select: { startedAt: true } });
      const resolvedTotalLatency = cleanNumber(totalLatency) ?? (trace?.startedAt ? Math.max(0, endedAtDate.getTime() - trace.startedAt.getTime()) : undefined);

      try {
        await prisma.apiTrace.upsert({
          where: { trackingId: cleanTrackingId },
          create: {
            trackingId: cleanTrackingId,
            entryMethod: 'UNKNOWN',
            entryUrl: 'UNKNOWN',
            startedAt: endedAtDate,
            statusCode: cleanStatusCode,
            endedAt: endedAtDate,
            totalLatency: resolvedTotalLatency,
            ...(validCompanyId && { companyId: validCompanyId }),
            ...(validUserId && { userId: validUserId }),
          },
          update: {
            statusCode: cleanStatusCode,
            endedAt: endedAtDate,
            totalLatency: resolvedTotalLatency,
            ...(validCompanyId && { companyId: validCompanyId }),
            ...(validUserId && { userId: validUserId }),
          },
        });
      } catch (error: any) {
        if (error.code === 'P2003') {
          await prisma.apiTrace.updateMany({
            where: { trackingId: cleanTrackingId },
            data: { statusCode: cleanStatusCode, endedAt: endedAtDate, totalLatency: resolvedTotalLatency }
          });
        }
      }
      res.status(200).json({ success: true });
    } catch (error) { next(error); }
  }

  static async createSpan(req: Request, res: Response, next: NextFunction) {
    try {
      const { id, trackingId, companyId, userId, parentSpanId, type, method, url, statusCode, headers, reqBody, resBody, latency, startedAt, endedAt } = req.body;
      const cleanTrackingId = cleanString(trackingId);
      if (!cleanTrackingId) return res.status(400).json({ error: 'trackingId is required' });

      const validCompanyId = cleanId(companyId || req.headers['company-id']);
      const validUserId = cleanId(userId || req.headers['user-id']);
      const cleanStartedAt = cleanDate(startedAt) || new Date();

      try {
        await prisma.apiTrace.upsert({
          where: { trackingId: cleanTrackingId },
          create: { trackingId: cleanTrackingId, entryMethod: method || 'UNKNOWN', entryUrl: url || 'UNKNOWN', startedAt: cleanStartedAt, ...(validCompanyId && { companyId: validCompanyId }), ...(validUserId && { userId: validUserId }) },
          update: { ...(validCompanyId && { companyId: validCompanyId }), ...(validUserId && { userId: validUserId }) }
        });
      } catch (e: any) {
        if (e.code === 'P2003') {
          await prisma.apiTrace.upsert({
            where: { trackingId: cleanTrackingId },
            create: { trackingId: cleanTrackingId, entryMethod: method || 'UNKNOWN', entryUrl: url || 'UNKNOWN', startedAt: cleanStartedAt },
            update: {}
          });
        }
      }

      try {
        const span = await prisma.apiSpan.create({
          data: {
            ...(cleanId(id) && { id: cleanString(id) }),
            trackingId: cleanTrackingId,
            ...(validCompanyId && { companyId: validCompanyId }),
            ...(validUserId && { userId: validUserId }),
            parentSpanId: cleanString(parentSpanId),
            type,
            method: cleanString(method) || 'UNKNOWN',
            url: cleanString(url) || 'UNKNOWN',
            statusCode: cleanNumber(statusCode),
            headers,
            reqBody,
            resBody,
            latency: cleanNumber(latency),
            startedAt: cleanStartedAt,
            endedAt: cleanDate(endedAt),
          },
        });
        res.status(201).json(span);
      } catch (error: any) {
        if (error.code === 'P2003') {
          const span = await prisma.apiSpan.create({
            data: {
              ...(cleanId(id) && { id: cleanString(id) }),
              trackingId: cleanTrackingId,
              parentSpanId: cleanString(parentSpanId),
              type,
              method: cleanString(method) || 'UNKNOWN',
              url: cleanString(url) || 'UNKNOWN',
              statusCode: cleanNumber(statusCode),
              headers,
              reqBody,
              resBody,
              latency: cleanNumber(latency),
              startedAt: cleanStartedAt,
              endedAt: cleanDate(endedAt),
            },
          });
          res.status(201).json(span);
        } else throw error;
      }
    } catch (error) { next(error); }
  }
}
