import { Request, Response, NextFunction } from 'express';
import requestIp from 'request-ip';
import crypto from 'crypto';
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

const getClientIp = (req: Request) => {
  return (
    cleanString(firstHeaderValue(req.headers['x-client-ip'])) ||
    cleanString(firstHeaderValue(req.headers['client-ip'])) ||
    cleanString(requestIp.getClientIp(req)) ||
    cleanString(req.ip) ||
    cleanString(req.socket.remoteAddress)
  );
};

const withClientIpHeaders = (
  headers: Request['headers'],
  clientIp?: string,
) => {
  return {
    ...headers,
    ...(clientIp && {
      'x-client-ip': clientIp,
      'client-ip': clientIp,
    }),
  };
};

/**
 * API TRACKER MIDDLEWARE FACTORY:
 * Creates a middleware that captures incoming requests and records them as Traces or Spans.
 *
 * Flow:
 * 1. Frontend → Middlelayer: No track-id header → creates a new PARENT trace (awaited)
 * 2. Middlelayer → Backend: Has track-id header → records as CHILD span on finish
 *
 * The parent trace is ALWAYS created first (awaited) before the request proceeds,
 * guaranteeing that child spans can reference the trace via FK.
 */
export const createTrackerMiddleware = (
  serviceType: 'MIDDLELAYER' | 'BACKEND',
) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Skip tracking for the tracker's own internal routes to avoid recursion
    // Skip tracking for internal tracker and monitoring routes to avoid recursion/pollution
    if (
      req.originalUrl.startsWith('/internal/tracker') ||
      req.originalUrl.startsWith('/internal/monitoring') ||
      req.originalUrl.startsWith('/api/v1/admin/monitoring')
    ) {
      return next();
    }

    // Extract tracking info from headers (propagated from upstream) or body
    const incomingTrackingId = cleanString(
      firstHeaderValue(req.headers['track-id']),
    );

    // If it's an internal route but has NO incoming tracking ID, it means the upstream
    // caller (Middlelayer) intentionally skipped tracking for this flow.
    // We must skip tracking too to avoid creating orphan "internal" root traces.
    if (req.originalUrl.startsWith('/internal/') && !incomingTrackingId) {
      return next();
    }
    const clientIp = getClientIp(req);
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

    const isMainEntry = !parentSpanId;
    let trackingId = incomingTrackingId;

    if (isMainEntry) {
      // Create a new parent Trace — this is AWAITED to ensure the trace row
      // exists in the DB before any downstream spans reference it.
      trackingId = await ApiTracker.startTrace({
        trackingId: incomingTrackingId,
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
      parentSpanId,
      companyId,
      userId,
      clientIp,
      serviceType,
    };

    // Persist the context for the duration of this request
    trackingStorage.run(context, () => {
      const startTime = Date.now();

      // Listen for the response to finish to record completion
      res.on('finish', () => {
        trackingStorage.run(context, () => {
          try {
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
              // Update the main trace with final status code, latency, and identity
              ApiTracker.endTrace(
                trackingId!,
                res.statusCode,
                serviceType,
                finalCompanyId,
                finalUserId,
                latency,
              );
            } else {
              // Record this request as a child span under the existing trace
              ApiTracker.createSpan({
                type: serviceType,
                method: req.method,
                url: req.originalUrl,
                parentSpanId,
                statusCode: res.statusCode,
                latency,
                reqBody: req.body,
                headers: withClientIpHeaders(req.headers, clientIp),
                startedAt: new Date(startTime),
                endedAt,
              });
            }
          } catch (e) {
            // Tracking failures must NEVER crash the response
            console.warn('[ApiTracker] Error in finish handler:', e);
          }
        });
      });

      // Propagate tracking ID to response headers
      res.setHeader('track-id', trackingId!);

      next();
    });
  };
};
