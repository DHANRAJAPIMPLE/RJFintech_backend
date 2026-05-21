import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../../shared/middlewares/error.middleware';
import { config } from '../../config';
import { internalPost } from '../../utils/internal-fetch.util';
import type {
  FetchMonitoringDetailsInternalResponse,
  FetchMonitoringDetailsRequest,
  FetchMonitoringDetailsResponse,
  FetchMonitoringSpansInternalResponse,
  FetchMonitoringSpansResponse,
  MonitoringApiErrorResponse,
} from './monitoring.type';

export class MonitoringController {
  static async fetchAll(
    req: Request,
    res: Response<FetchMonitoringSpansResponse>,
    next: NextFunction,
  ) {
    try {
      const body =
        req.body && typeof req.body === 'object' && Object.keys(req.body).length
          ? req.body
          : undefined;
      const { data, ok, status } =
        await internalPost<FetchMonitoringSpansInternalResponse>(
          `${config.backendUrl}/monitoring/fetch-all`,
          body,
        );

      if (!ok) {
        const errorData = data as MonitoringApiErrorResponse;
        throw new AppError(
          errorData?.message ||
            errorData?.error ||
            'Failed to fetch monitoring spans',
          status,
        );
      }

      return res.status(200).json(data as FetchMonitoringSpansResponse);
    } catch (error) {
      return next(error);
    }
  }

  static async details(
    req: Request,
    res: Response<FetchMonitoringDetailsResponse>,
    next: NextFunction,
  ) {
    try {
      const body = (req.body ?? {}) as FetchMonitoringDetailsRequest;
      const trackingId =
        body.trackingId ||
        body.trackId ||
        body.tracking_id ||
        req.get('x-tracking-id');
      const { data, ok, status } =
        await internalPost<FetchMonitoringDetailsInternalResponse>(
          `${config.backendUrl}/monitoring/detaisls`,
          {
            ...body,
            trackingId,
          },
        );

      if (!ok) {
        const errorData = data as MonitoringApiErrorResponse;
        throw new AppError(
          errorData?.message ||
            errorData?.error ||
            'Failed to fetch monitoring details',
          status,
        );
      }

      return res.status(200).json(data as FetchMonitoringDetailsResponse);
    } catch (error) {
      return next(error);
    }
  }
}
