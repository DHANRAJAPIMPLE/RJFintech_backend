import { randomUUID } from 'node:crypto';
import type { NextFunction, Response } from 'express';
import {
  captureResponseBody,
  getCapturedResponseSize,
} from '../../shared/utils/monitoring/captureResponseBody';
import { extractClientIp } from '../../shared/utils/monitoring/extractClientIp';
import { hasDefinedExpressRoute } from '../../shared/utils/monitoring/hasDefinedExpressRoute';
import { asUuid } from '../../shared/utils/monitoring/monitoringIds';
import { sanitizeMonitoringPayload } from '../../shared/utils/monitoring/sanitizeMonitoringPayload';
import { shouldSkipMonitoring } from '../../shared/utils/monitoring/shouldSkipMonitoring';
import { storeMiddlelayerApiSpan } from '../services/monitoringClient.service';
import {
  runWithMonitoringRequest,
  type MonitoringRequest,
} from '../utils/monitoring-context.util';

const getStringHeader = (
  req: MonitoringRequest,
  header: string,
): string | null => {
  const value = req.get(header);
  return value && value.trim() ? value.trim() : null;
};

const extractCompanyId = (req: MonitoringRequest, res: Response): string | null => {
  const resBody = res.locals.monitoringResponseBody;
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

const extractUserId = (req: MonitoringRequest, res: Response): string | null => {
  const resBody = res.locals.monitoringResponseBody;
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

export const traceMonitoringMiddleware = (
  req: MonitoringRequest,
  res: Response,
  next: NextFunction,
) => {
  if (shouldSkipMonitoring(req)) {
    req.monitoring = {
      trackingId: randomUUID(),
      backendCounter: 0,
      subCount: 'm1',
      skipStorage: true,
    };
    return runWithMonitoringRequest(req, next);
  }

  const trackingId =
    asUuid(getStringHeader(req, 'x-tracking-id')) || randomUUID();
  const startedAt = new Date();
  const startedAtMs = Date.now();

  req.monitoring = {
    trackingId,
    backendCounter: 0,
    subCount: 'm1',
  };

  res.setHeader('x-tracking-id', trackingId);
  captureResponseBody(res);

  res.on('finish', () => {
    if (res.locals.monitoringLogged) return;
    res.locals.monitoringLogged = true;

    if (!hasDefinedExpressRoute(req)) {
      return;
    }

    const endedAt = new Date();

    void storeMiddlelayerApiSpan({
      trackingId,
      subCount: 'm1',
      type: 'MIDDLELAYER',
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      headers: sanitizeMonitoringPayload(req.headers),
      reqBody: sanitizeMonitoringPayload(req.body ?? null),
      resBody: sanitizeMonitoringPayload(
        res.locals.monitoringResponseBody ?? null,
      ),
      responseSize: getCapturedResponseSize(res),
      resHeaders: sanitizeMonitoringPayload(res.getHeaders()),
      latency: Date.now() - startedAtMs,
      ipAddress: extractClientIp(req),
      companyId: extractCompanyId(req, res),
      userId: extractUserId(req, res),
      startedAt,
      endedAt,
    });
  });

  return runWithMonitoringRequest(req, next);
};
