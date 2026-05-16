import type { NextFunction, Request, Response } from 'express';
import type { z } from 'zod';
import { MonitoringService } from './monitoring.service';
import { monitoringApiSpanSchema } from './monitoring.validators';

const formatZodIssues = (issues: z.ZodIssue[]) => {
  return issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
};

const getOptionalLimit = (value: unknown): number => {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return 100;
  }

  return Math.min(Math.max(Math.trunc(parsed), 1), 500);
};

const getTrackingId = (req: Request): string | null => {
  const value =
    req.body?.trackingId ||
    req.body?.trackId ||
    req.body?.tracking_id ||
    req.get('x-tracking-id');

  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

export class MonitoringController {
  static async createMiddlelayerApiSpan(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const parsed = monitoringApiSpanSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Invalid monitoring api span payload',
          details: formatZodIssues(parsed.error.issues),
        });
      }

      const apiSpan = await MonitoringService.createApiSpan(parsed.data);
      return res.status(201).json(apiSpan);
    } catch (error) {
      return next(error);
    }
  }

  static async fetchAll(req: Request, res: Response, next: NextFunction) {
    try {
      const spans = await MonitoringService.fetchAllMiddlelayerSpans(
        getOptionalLimit(req.body?.limit ?? req.query?.limit),
      );
      return res.status(200).json(spans);
    } catch (error) {
      return next(error);
    }
  }

  static async details(req: Request, res: Response, next: NextFunction) {
    try {
      const trackingId = getTrackingId(req);

      if (!trackingId) {
        return res.status(400).json({ error: 'trackingId is required' });
      }

      const trace = await MonitoringService.getTraceDetails(trackingId);

      if (!trace) {
        return res.status(404).json({ error: 'Monitoring trace not found' });
      }

      return res.status(200).json(trace);
    } catch (error) {
      return next(error);
    }
  }
}

export { MonitoringController as MonitoringDbController };
