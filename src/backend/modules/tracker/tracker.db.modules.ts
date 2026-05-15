import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../lib/prisma';

const cleanString = (value: unknown) => {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const cleanNumber = (value: unknown) => {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
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
      const cleanCompanyId = cleanString(companyId);
      const cleanUserId = cleanString(userId);

      const trace = await prisma.apiTrace.upsert({
        where: { trackingId },
        create: {
          trackingId,
          ...(cleanCompanyId && { companyId: cleanCompanyId }),
          ...(cleanUserId && { userId: cleanUserId }),
          entryMethod,
          entryUrl,
          startedAt: startedAt ? new Date(startedAt) : new Date(),
        },
        update: {
          ...(cleanCompanyId && { companyId: cleanCompanyId }),
          ...(cleanUserId && { userId: cleanUserId }),
        },
      });

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
      const endedAtDate = endedAt ? new Date(endedAt) : new Date();
      const cleanCompanyId = cleanString(companyId);
      const cleanUserId = cleanString(userId);
      const trace = await prisma.apiTrace.findUnique({
        where: { trackingId },
        select: { startedAt: true },
      });
      const resolvedTotalLatency =
        cleanNumber(totalLatency) ??
        (trace?.startedAt
          ? Math.max(0, endedAtDate.getTime() - trace.startedAt.getTime())
          : undefined);

      // Use updateMany to avoid "Record not found" error if createTrace hasn't finished yet
      // or if it failed to create. This is safer for non-critical logging.
      const result = await prisma.apiTrace.updateMany({
        where: { trackingId },
        data: {
          statusCode,
          endedAt: endedAtDate,
          ...(typeof resolvedTotalLatency === 'number' && {
            totalLatency: resolvedTotalLatency,
          }),
          ...(cleanCompanyId && { companyId: cleanCompanyId }),
          ...(cleanUserId && { userId: cleanUserId }),
        },
      });

      res.status(200).json({ success: true, updated: result.count });
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
      const cleanCompanyId = cleanString(companyId);
      const cleanUserId = cleanString(userId);
      const cleanParentSpanId =
        cleanString(parentSpanId) ||
        cleanString(parentId) ||
        cleanString(req.body['parent_id']);

      const span = await prisma.apiSpan.create({
        data: {
          ...(cleanId && { id: cleanId }),
          trackingId,
          ...(cleanCompanyId && { companyId: cleanCompanyId }),
          ...(cleanUserId && { userId: cleanUserId }),
          ...(cleanParentSpanId && { parentSpanId: cleanParentSpanId }),
          type,
          method,
          url,
          statusCode,
          headers,
          reqBody,
          resBody,
          latency,
          startedAt: startedAt ? new Date(startedAt) : new Date(),
          endedAt: endedAt ? new Date(endedAt) : undefined,
        },
      });

      res.status(201).json(span);
    } catch (error) {
      next(error);
    }
  }
}
