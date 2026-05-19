import type { NextFunction, Response } from 'express';
import { AppError } from '../../shared/middlewares/error.middleware';
import { onNotificationEvent } from '../../shared/utils/notification-events.util';
import { getPagination } from '../../shared/utils/pagination.util';
import type { AuthRequest } from '../middlewares/auth.middleware';
import { config } from '../config';
import { internalPost } from '../utils/internal-fetch.util';

export class NotificationController {
  static async stream(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user?.id;
      const companyId = req.user?.companyId;

      if (!userId || !companyId) {
        throw new AppError('Unauthorized', 401);
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      const send = (event: string, data: unknown) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      send('connected', { ok: true });

      const unsubscribe = onNotificationEvent((payload) => {
        if (payload.userId === userId && payload.companyId === companyId) {
          send('notification', payload.notification);
        }
      });

      const heartbeat = setInterval(() => {
        send('heartbeat', { at: new Date().toISOString() });
      }, 30000);

      req.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
        res.end();
      });
    } catch (error) {
      next(error);
    }
  }

  static async fetch(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user?.id;
      const companyId = req.user?.companyId;
      if (!userId || !companyId) {
        throw new AppError('Unauthorized', 401);
      }

      const { offset, limit } = getPagination(req.body);
      const cursorId = req.body?.cursorId || req.body?.cursor || null;
      const { data, ok, status } = await internalPost<any>(
        `${config.backendUrl}/internal/notifications/fetch`,
        {
          status: req.body?.status || 'ALL',
          userId,
          companyId,
          cursorId,
          offset,
          limit,
        },
      );

      if (!ok) {
        throw new AppError(
          data?.message || data?.error || 'Failed to fetch notifications',
          status,
        );
      }

      return res.status(200).json(data);
    } catch (error) {
      return next(error);
    }
  }

  static async markRead(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user?.id;
      const companyId = req.user?.companyId;
      if (!userId || !companyId) {
        throw new AppError('Unauthorized', 401);
      }

      const { data, ok, status } = await internalPost<any>(
        `${config.backendUrl}/internal/notifications/read`,
        {
          ...req.body,
          userId,
          companyId,
        },
      );

      if (!ok) {
        throw new AppError(
          data?.message || data?.error || 'Failed to update notification',
          status,
        );
      }

      return res.status(200).json(data);
    } catch (error) {
      return next(error);
    }
  }
}
