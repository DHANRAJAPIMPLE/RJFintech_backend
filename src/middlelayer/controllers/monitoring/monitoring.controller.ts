import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../../shared/middlewares/error.middleware';
import { config } from '../../config';
import { internalPost } from '../../utils/internal-fetch.util';
import { zodParse } from '../../utils/zod-parse.util';
import {
  monitoringDetailsBodySchema,
  monitoringFetchAllSchema,
  monitoringTrackingIdSchema,
} from '../../validations/monitoring.validation';
import type {
  FetchMonitoringDetailsInternalResponse,
  FetchMonitoringDetailsResponse,
  FetchMonitoringSpanInternalItem,
  FetchMonitoringSpansInternalResponse,
  FetchMonitoringSpansResponse,
  MonitoringApiErrorResponse,
} from './monitoring.type';

export class MonitoringController {
  private static formatFetchAllSpan(
    span: FetchMonitoringSpanInternalItem,
  ): FetchMonitoringSpansResponse[number] {
    return {
      trackingId: span.trackingId,
      apiUrl: span.apiUrl,
      statusCode: span.statusCode,
      ip: span.ip,
      spanCount: span.spanCount,
      companyName: span.companyName,
      companyCode: span.companyCode,
      userName: span.userName,
      userEmail: span.userEmail,
      createdAt: span.createdAt,
    };
  }

  static async fetchAll(
    req: Request,
    res: Response<FetchMonitoringSpansResponse>,
    next: NextFunction,
  ) {
    try {
      const body = zodParse(monitoringFetchAllSchema, req.body ?? {});
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

      const spans = data as FetchMonitoringSpanInternalItem[];
      return res
        .status(200)
        .json(spans.map(MonitoringController.formatFetchAllSpan));
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
      const body = zodParse(monitoringDetailsBodySchema, req.body ?? {});
      const { trackingId } = zodParse(monitoringTrackingIdSchema, {
        trackingId:
          body.trackingId ||
          body.trackId ||
          body.tracking_id ||
          req.get('x-tracking-id'),
      });
      const { data, ok, status } =
        await internalPost<FetchMonitoringDetailsInternalResponse>(
          `${config.backendUrl}/monitoring/details`,
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
