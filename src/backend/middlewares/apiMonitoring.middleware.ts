import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import {
  captureResponseBody,
  getCapturedResponseSize,
} from '../../shared/utils/monitoring/captureResponseBody';
import { extractClientIp } from '../../shared/utils/monitoring/extractClientIp';
import { hasDefinedExpressRoute } from '../../shared/utils/monitoring/hasDefinedExpressRoute';
import {
  asNonEmptyString,
  asUuid,
} from '../../shared/utils/monitoring/monitoringIds';
import { shouldSkipMonitoring } from '../../shared/utils/monitoring/shouldSkipMonitoring';
import { MonitoringService } from '../modules/monitoring/monitoring.db.modules';

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

const extractCompanyId = (req: BackendMonitoringRequest, res: Response): string | null => {
  const resBody = res.locals.backendMonitoringResponseBody;
  return (
    asUuid(res.locals.companyId) ||
    asUuid(req.user?.companyId) ||
    asUuid(getStringHeader(req, 'x-company-id')) ||
    asUuid(req.body?.companyId) ||
    asUuid(resBody?.companyId) ||
    asUuid(resBody?.data?.companyId) ||
    asUuid(resBody?.user?.companyId) ||
    asUuid(resBody?.data?.user?.companyId) ||
    asUuid(resBody?.userMappings?.[0]?.companyId) ||
    asUuid(resBody?.user?.userMappings?.[0]?.companyId) ||
    null
  );
};

const extractUserId = (req: BackendMonitoringRequest, res: Response): string | null => {
  const resBody = res.locals.backendMonitoringResponseBody;
  return (
    asUuid(res.locals.userId) ||
    asUuid(req.user?.id) ||
    asUuid(req.user?.userId) ||
    asUuid(getStringHeader(req, 'x-user-id')) ||
    asUuid(req.body?.userId) ||
    asUuid(resBody?.userId) ||
    asUuid(resBody?.id) ||
    asUuid(resBody?.data?.userId) ||
    asUuid(resBody?.data?.id) ||
    asUuid(resBody?.user?.id) ||
    asUuid(resBody?.data?.user?.id) ||
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
    'backendMonitoringResponseSize',
  );

  res.on('finish', () => {
    if (res.locals.backendMonitoringLogged) return;
    res.locals.backendMonitoringLogged = true;

    if (!hasDefinedExpressRoute(req)) {
      return;
    }

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
      responseSize: getCapturedResponseSize(
        res,
        'backendMonitoringResponseSize',
      ),
      resHeaders: res.getHeaders(),
      latency: Date.now() - startedAtMs,
      ipAddress: extractClientIp(req),
      companyId: extractCompanyId(req, res),
      userId: extractUserId(req, res),
      startedAt,
      endedAt: new Date(),
    }).catch((error) => {
      console.error('[Monitoring] Failed to store backend API span', error);
    });
  });

  return next();
};
