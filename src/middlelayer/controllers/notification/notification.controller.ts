import type { NextFunction, Response } from 'express';
import { AppError } from '../../../shared/middlewares/error.middleware';
import { onNotificationEvent } from '../../../shared/utils/notification-events.util';
import type { AuthRequest } from '../../middlewares/auth.middleware';
import { config } from '../../config';
import { internalPost } from '../../utils/internal-fetch.util';
import { zodParse } from '../../utils/zod-parse.util';
import {
  notificationFetchSchema,
  notificationReadSchema,
} from '../../validations/notification.validation';
import type {
  FetchNotificationsInternalResponse,
  FetchNotificationsResponse,
  MarkNotificationReadInternalResponse,
  MarkNotificationReadResponse,
  NotificationApiErrorResponse,
  NotificationSseEventName,
  NotificationSseEventPayloadMap,
  NotificationSseNotificationEvent,
} from './notification.type';

export class NotificationController {
  private static async isSaasAdmin(userId: string) {
    const { data, ok } = await internalPost<any>(
      `${config.backendAuthUrl}/get-role`,
      { userId },
    );

    return (
      ok &&
      Array.isArray(data) &&
      data.some((access) => access?.roleCode === 'SAAS_ADMIN')
    );
  }

  static async stream(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user?.id;
      const companyId = req.user?.companyId;

      if (!userId || !companyId) {
        throw new AppError('Unauthorized', 401);
      }

      const includeAllCompanies =
        await NotificationController.isSaasAdmin(userId);

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      const send = <EventName extends NotificationSseEventName>(
        event: EventName,
        data: NotificationSseEventPayloadMap[EventName],
      ) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      send('connected', { ok: true });

      const unsubscribe = onNotificationEvent((payload) => {
        if (
          payload.userId === userId &&
          (includeAllCompanies || payload.companyId === companyId)
        ) {
          send(
            'notification',
            payload.notification as NotificationSseNotificationEvent,
          );
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

  static async fetch(
    req: AuthRequest,
    res: Response<FetchNotificationsResponse>,
    next: NextFunction,
  ) {
    try {
      const userId = req.user?.id;
      const companyId = req.user?.companyId;
      if (!userId || !companyId) {
        throw new AppError('Unauthorized', 401);
      }

      const {
        status: notificationStatus,
        cursorId: parsedCursorId,
        cursor,
        offset,
        limit,
      } = zodParse(notificationFetchSchema, req.body ?? {});
      const cursorId = parsedCursorId || cursor || null;
      const { data, ok, status } =
        await internalPost<FetchNotificationsInternalResponse>(
          `${config.backendUrl}/internal/notifications/fetch`,
          {
            status: notificationStatus,
            userId,
            companyId,
            cursorId,
            offset,
            limit,
            includeAllCompanies: true,
          },
        );

      if (!ok) {
        const errorData = data as NotificationApiErrorResponse;
        throw new AppError(
          errorData?.message ||
            errorData?.error ||
            'Failed to fetch notifications',
          status,
        );
      }

      const response = data as FetchNotificationsResponse;

      return res.status(200).json(response);
    } catch (error) {
      return next(error);
    }
  }

  static async markRead(
    req: AuthRequest,
    res: Response<MarkNotificationReadResponse>,
    next: NextFunction,
  ) {
    try {
      const userId = req.user?.id;
      const companyId = req.user?.companyId;
      if (!userId || !companyId) {
        throw new AppError('Unauthorized', 401);
      }

      const body = zodParse(notificationReadSchema, req.body ?? {});
      const { data, ok, status } =
        await internalPost<MarkNotificationReadInternalResponse>(
          `${config.backendUrl}/internal/notifications/read`,
          {
            ...body,
            userId,
            companyId,
            includeAllCompanies: true,
          },
        );

      if (!ok) {
        const errorData = data as NotificationApiErrorResponse;
        throw new AppError(
          errorData?.message ||
            errorData?.error ||
            'Failed to update notification',
          status,
        );
      }

      return res.status(200).json(data as MarkNotificationReadResponse);
    } catch (error) {
      return next(error);
    }
  }
}
