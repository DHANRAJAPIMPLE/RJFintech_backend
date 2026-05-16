import { randomUUID } from 'node:crypto';
import type { NextFunction, Response } from 'express';
import { captureResponseBody } from '../../shared/utils/monitoring/captureResponseBody';
import { extractClientIp } from '../../shared/utils/monitoring/extractClientIp';
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

const extractCompanyId = (req: MonitoringRequest): string | null => {
  return (
    asUuid(req.user?.companyId) ||
    asUuid(getStringHeader(req, 'x-company-id')) ||
    asUuid(req.body?.companyId) ||
    null
  );
};

const extractUserId = (req: MonitoringRequest): string | null => {
  return (
    asUuid(req.user?.id) ||
    asUuid(getStringHeader(req, 'x-user-id')) ||
    asUuid(req.body?.userId) ||
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
      resHeaders: sanitizeMonitoringPayload(res.getHeaders()),
      latency: Date.now() - startedAtMs,
      ipAddress: extractClientIp(req),
      companyId: extractCompanyId(req),
      userId: extractUserId(req),
      startedAt,
      endedAt,
    });
  });

  return runWithMonitoringRequest(req, next);
};
