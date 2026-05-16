import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request } from 'express';
import { asUuid } from '../../shared/utils/monitoring/monitoringIds';

export type MonitoringRequest = Request & {
  user?: {
    id?: string;
    companyId?: string;
  };
  monitoring?: {
    trackingId: string;
    backendCounter: number;
    subCount: string;
    skipStorage?: boolean;
  };
};

const monitoringRequestStorage = new AsyncLocalStorage<MonitoringRequest>();

export const runWithMonitoringRequest = (
  req: MonitoringRequest,
  callback: () => void,
): void => {
  monitoringRequestStorage.run(req, callback);
};

export const getMonitoringRequest = (): MonitoringRequest | undefined => {
  return monitoringRequestStorage.getStore();
};

export const attachTrackingHeaders = (
  headers: Record<string, string> = {},
  backendBody?: Record<string, unknown>,
): Record<string, string> => {
  const req = getMonitoringRequest();
  const trackingId = req?.monitoring?.trackingId;

  if (req?.monitoring?.skipStorage) {
    return {
      ...headers,
      'x-skip-api-monitoring': 'true',
    };
  }

  if (!req?.monitoring || !trackingId) {
    return headers;
  }

  req.monitoring.backendCounter += 1;
  const subCount = `b${req.monitoring.backendCounter}`;
  req.monitoring.subCount = subCount;

  const companyId =
    asUuid(req.user?.companyId) ||
    asUuid(req.get('x-company-id')) ||
    asUuid(req.body?.companyId) ||
    asUuid(backendBody?.companyId);
  const userId =
    asUuid(req.user?.id) ||
    asUuid(req.get('x-user-id')) ||
    asUuid(req.body?.userId) ||
    asUuid(backendBody?.userId);

  return {
    ...headers,
    'x-tracking-id': trackingId,
    'x-sub-count': subCount,
    ...(companyId ? { 'x-company-id': companyId } : {}),
    ...(userId ? { 'x-user-id': userId } : {}),
  };
};
