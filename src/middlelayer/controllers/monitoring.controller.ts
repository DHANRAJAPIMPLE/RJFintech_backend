import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../shared/middlewares/error.middleware';
import { config } from '../config';
import { internalPost } from '../utils/internal-fetch.util';

export class MonitoringController {
  static async fetchAll(req: Request, res: Response, next: NextFunction) {
    try {
      const body =
        req.body && typeof req.body === 'object' && Object.keys(req.body).length
          ? req.body
          : undefined;
      const { data, ok, status } = await internalPost<any>(
        `${config.backendUrl}/monitoring/fetch-all`,
        body,
      );

      if (!ok) {
        throw new AppError(
          data?.message || data?.error || 'Failed to fetch monitoring spans',
          status,
        );
      }

      return res.status(200).json(data);
    } catch (error) {
      return next(error);
    }
  }

  static async details(req: Request, res: Response, next: NextFunction) {
    try {
      const trackingId =
        req.body?.trackingId ||
        req.body?.trackId ||
        req.body?.tracking_id ||
        req.get('x-tracking-id');
      const { data, ok, status } = await internalPost<any>(
        `${config.backendUrl}/monitoring/detaisls`,
        {
          ...(req.body ?? {}),
          trackingId,
        },
      );

      if (!ok) {
        throw new AppError(
          data?.message || data?.error || 'Failed to fetch monitoring details',
          status,
        );
      }

      return res.status(200).json(data);
    } catch (error) {
      return next(error);
    }
  }
}
