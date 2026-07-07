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
  notificationSettingsFetchSchema,
  notificationSettingsUpdateSchema,
} from '../../validations/notification.validation';
import type {
  FetchNotificationSettingsResponse,
  FetchNotificationsInternalResponse,
  FetchNotificationsResponse,
  MarkNotificationReadInternalResponse,
  MarkNotificationReadResponse,
  NotificationApiErrorResponse,
  NotificationFetchRequest,
  NotificationSseEventName,
  NotificationSseEventPayloadMap,
  NotificationSseNotificationEvent,
  UpdateNotificationSettingsRequest,
  UpdateNotificationSettingsResponse,
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
        refType,
        module,
        type,
        filters,
        dateRange,
        fromDate,
        toDate,
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
            status: filters?.status || notificationStatus,
            refType: filters?.module || filters?.refType || module || refType,
            type: filters?.type || type,
            dateRange,
            fromDate,
            toDate,
            userId,
            companyId,
            cursorId,
            offset,
            limit,
            includeAllCompanies: true,
          } satisfies NotificationFetchRequest & {
            userId: string;
            companyId: string;
            includeAllCompanies: boolean;
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

  static async fetchSettings(
    req: AuthRequest,
    res: Response<FetchNotificationSettingsResponse>,
    next: NextFunction,
  ) {
    try {
      const userId = req.user?.id;
      const companyId = req.user?.companyId;
      if (!userId || !companyId) {
        throw new AppError('Unauthorized', 401);
      }

      zodParse(notificationSettingsFetchSchema, req.body ?? {});
      const includeAllCompanies =
        await NotificationController.isSaasAdmin(userId);

      const { data, ok, status } =
        await internalPost<FetchNotificationSettingsResponse | NotificationApiErrorResponse>(
          `${config.backendUrl}/internal/notifications/fetch-settings`,
          {
            userId,
            companyId,
            includeAllCompanies,
          },
        );

      if (!ok) {
        const errorData = data as NotificationApiErrorResponse;
        throw new AppError(
          errorData?.message ||
            errorData?.error ||
            'Failed to fetch notification settings',
          status,
        );
      }

      return res.status(200).json(data as FetchNotificationSettingsResponse);
    } catch (error) {
      return next(error);
    }
  }

  static async updateSettings(
    req: AuthRequest,
    res: Response<UpdateNotificationSettingsResponse>,
    next: NextFunction,
  ) {
    try {
      const userId = req.user?.id;
      const companyId = req.user?.companyId;
      if (!userId || !companyId) {
        throw new AppError('Unauthorized', 401);
      }

      const body = zodParse(notificationSettingsUpdateSchema, req.body ?? {});
      const includeAllCompanies =
        await NotificationController.isSaasAdmin(userId);

      const { data, ok, status } =
        await internalPost<
          UpdateNotificationSettingsResponse | NotificationApiErrorResponse
        >(`${config.backendUrl}/internal/notifications/settings`, {
          userId,
          companyId,
          eventUserId: userId,
          companies: body,
          includeAllCompanies,
        } satisfies {
          userId: string;
          companyId: string;
          eventUserId: string;
          companies: UpdateNotificationSettingsRequest;
          includeAllCompanies: boolean;
        });

      if (!ok) {
        const errorData = data as NotificationApiErrorResponse;
        throw new AppError(
          errorData?.message ||
            errorData?.error ||
            'Failed to update notification settings',
          status,
        );
      }

      return res.status(200).json(data as UpdateNotificationSettingsResponse);
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
