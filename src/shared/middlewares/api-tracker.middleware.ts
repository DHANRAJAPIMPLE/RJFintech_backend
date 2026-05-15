import { Request, Response, NextFunction } from 'express';
import {
  ApiTracker,
  trackingStorage,
  TrackingContext,
} from '../utils/tracker.util';

const firstHeaderValue = (value: string | string[] | undefined) => {
  if (Array.isArray(value)) return value[0];
  return value;
};

const cleanString = (value: unknown) => {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

/**
 * API TRACKER MIDDLEWARE FACTORY:
 * Creates a middleware that captures incoming requests and records them as Traces or Spans.
 */
export const createTrackerMiddleware = (
  serviceType: 'MIDDLELAYER' | 'BACKEND',
) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Skip tracking for the tracker's own internal routes to avoid recursion
    if (req.originalUrl.startsWith('/internal/tracker')) {
      return next();
    }

    // Extract tracking info from headers (propagated from upstream) or body
    const incomingTrackingId = cleanString(
    firstHeaderValue(req.headers['track-id'])
    );
    // Initial attempt to get IDs (e.g. from public routes or if already present)
    const companyId =
      cleanString(firstHeaderValue(req.headers['company-id'])) ||
      cleanString(req.body?.companyId) ||
      cleanString(req.body?.company_id);
    const userId =
      cleanString(firstHeaderValue(req.headers['user-id'])) ||
      cleanString(req.body?.userId) ||
      cleanString(req.body?.user_id);
    const parentSpanId =
      cleanString(firstHeaderValue(req.headers['parent-span-id'])) ||
      cleanString(firstHeaderValue(req.headers['parent-id'])) ||
      cleanString(req.body?.parentSpanId) ||
      cleanString(req.body?.parent_id);

    const isMainEntry = !incomingTrackingId;
    let trackingId = incomingTrackingId;

    if (isMainEntry) {
      // Create a new Trace for the entry request
      trackingId = await ApiTracker.startTrace({
        entryMethod: req.method,
        entryUrl: req.originalUrl,
        companyId,
        userId,
        serviceType,
      });
    }

    if (!trackingId) {
      return next();
    }

    // Create a mutable context object so it can be updated by authMiddleware
    const context: TrackingContext = {
      trackingId,
      companyId,
      userId,
      serviceType,
    };

    // Persist the context for the duration of this request
    trackingStorage.run(context, () => {
      const startTime = Date.now();

      // Listen for the response to finish to record completion
      res.on('finish', () => {
        trackingStorage.run(context, () => {
          const endedAt = new Date();
          const latency = endedAt.getTime() - startTime;

          // Late binding: Get final IDs from req.user (populated by authMiddleware)
          const finalUserId =
            cleanString((req as any).user?.id) || context.userId;
          const finalCompanyId =
            cleanString((req as any).user?.companyId) || context.companyId;

          ApiTracker.setIdentity({
            companyId: finalCompanyId,
            userId: finalUserId,
          });

          if (isMainEntry) {
            // Update the main trace with final information
            ApiTracker.endTrace(
              trackingId,
              res.statusCode,
              serviceType,
              finalCompanyId,
              finalUserId,
              latency,
            );
          } else {
            // Record this request as an internal span
            ApiTracker.createSpan({
              type: serviceType,
              method: req.method,
              url: req.originalUrl,
              parentSpanId,
              statusCode: res.statusCode,
              latency,
              reqBody: req.body,
              headers: req.headers,
              startedAt: new Date(startTime),
              endedAt,
            });
          }
        });
      });

      // Propagate tracking ID to response headers
      res.setHeader('track-id', trackingId);

      next();
    });
  };
};
