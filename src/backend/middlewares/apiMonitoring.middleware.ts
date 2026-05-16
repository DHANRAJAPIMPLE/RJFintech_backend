import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { captureResponseBody } from '../../shared/utils/monitoring/captureResponseBody';
import { extractClientIp } from '../../shared/utils/monitoring/extractClientIp';
import {
  asNonEmptyString,
  asUuid,
} from '../../shared/utils/monitoring/monitoringIds';
import { shouldSkipMonitoring } from '../../shared/utils/monitoring/shouldSkipMonitoring';
import { MonitoringService } from '../modules/monitoring/monitoring.service';

type BackendMonitoringRequest = Request & {
  user?: {
    id?: string;
    userId?: string;
    companyId?: string;
  };
};

const getStringHeader = (req: Request, header: string): string | null => {
  const value = req.get(header);
  return value && value.trim() ? value.trim() : null;
};

const extractCompanyId = (req: BackendMonitoringRequest): string | null => {
  return (
    asUuid(req.user?.companyId) ||
    asUuid(getStringHeader(req, 'x-company-id')) ||
    asUuid(req.body?.companyId) ||
    null
  );
};

const extractUserId = (req: BackendMonitoringRequest): string | null => {
  return (
    asUuid(req.user?.id) ||
    asUuid(req.user?.userId) ||
    asUuid(getStringHeader(req, 'x-user-id')) ||
    asUuid(req.body?.userId) ||
    null
  );
};

export const apiMonitoringMiddleware = (
  req: BackendMonitoringRequest,
  res: Response,
  next: NextFunction,
) => {
  if (req.get('x-skip-api-monitoring') === 'true') {
    return next();
  }

  if (shouldSkipMonitoring(req)) {
    return next();
  }

  const trackingId =
    asUuid(getStringHeader(req, 'x-tracking-id')) || randomUUID();
  const subCount =
    asNonEmptyString(getStringHeader(req, 'x-sub-count')) || 'b-unknown';
  const startedAt = new Date();
  const startedAtMs = Date.now();

  res.setHeader('x-tracking-id', trackingId);
  captureResponseBody(
    res,
    'backendMonitoringResponseBody',
    'backendMonitoringResponseCaptured',
  );

  res.on('finish', () => {
    if (res.locals.backendMonitoringLogged) return;
    res.locals.backendMonitoringLogged = true;

    void MonitoringService.createApiSpan({
      trackingId,
      subCount,
      type: 'BACKEND',
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      headers: req.headers,
      reqBody: req.body ?? null,
      resBody: res.locals.backendMonitoringResponseBody ?? null,
      resHeaders: res.getHeaders(),
      latency: Date.now() - startedAtMs,
      ipAddress: extractClientIp(req),
      companyId: extractCompanyId(req),
      userId: extractUserId(req),
      startedAt,
      endedAt: new Date(),
    }).catch((error) => {
      console.error('[Monitoring] Failed to store backend API span', error);
    });
  });

  return next();
};
