import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { emitNotificationEvent } from '../../../shared/utils/notification-events.util';
import { getPagination } from '../../../shared/utils/pagination.util';
import { prisma } from '../../lib/prisma';

type NotificationType = 'INITIATE' | 'APPROVE' | 'REJECT';

type CreateNotificationInput = {
  companyId: string;
  name: string;
  message: string;
  type: NotificationType;
  referenceType?: string | null;
  referenceId?: string | null;
  createdBy: string;
  recipientUserIds?: string[];
};

const normalizeStatus = (value: unknown) => {
  const status = typeof value === 'string' ? value.trim().toUpperCase() : 'ALL';
  return ['READ', 'UNREAD', 'ARCHIVED', 'ALL'].includes(status)
    ? status
    : 'ALL';
};

const formatNotification = (row: any) => ({
  id: row.id,
  name: row.notification.name,
  message: row.notification.message,
  type: row.notification.type,
  refType: row.notification.referenceType,
  status: row.status,
  createdByname: row.notification.createdByUser?.name || null,
  createdByemail: row.notification.createdByUser?.email || null,
  createat_timestamp: row.notification.createdAt,
});

export class NotificationService {
  private static unique(values: Array<string | null | undefined>) {
    return Array.from(new Set(values.filter(Boolean) as string[]));
  }

  private static async getSaasAdminUserIds(companyId: string) {
    const accesses = await prisma.userAccess.findMany({
      where: {
        companyId,
        roleCode: 'SAAS_ADMIN',
        user: {
          userMappings: {
            some: { companyId, status: 'ACTIVE' },
          },
        },
      },
      select: { userId: true },
    });

    return accesses.map((access) => access.userId);
  }

  static async getCurrentApproverIds(
    reqId: string,
    reqTable: string,
    fallbackUserIds: string[] = [],
  ) {
    const currentLevel = await prisma.workflowApprover.findFirst({
      where: { reqId, reqTable, status: 'PENDING' },
      orderBy: { level: 'asc' },
    });

    if (Array.isArray(currentLevel?.approversList)) {
      return currentLevel.approversList as string[];
    }

    return fallbackUserIds;
  }

  static async createNotification(input: CreateNotificationInput) {
    const saasAdmins = await NotificationService.getSaasAdminUserIds(
      input.companyId,
    );
    const recipientUserIds = NotificationService.unique([
      ...(input.recipientUserIds || []),
      ...saasAdmins,
    ]).filter((userId) => userId !== input.createdBy);

    if (recipientUserIds.length === 0) return null;

    const notificationId = randomUUID();
    const now = new Date();
    const notificationUsers = recipientUserIds.map((userId) => ({
      id: randomUUID(),
      companyId: input.companyId,
      userId,
      notificationId,
      status: 'UNREAD',
      updatedAt: now,
    }));

    const notification = await prisma.$transaction(async (tx) => {
      const createdNotification = await tx.notification.create({
        data: {
          id: notificationId,
          companyId: input.companyId,
          name: input.name,
          message: input.message,
          type: input.type,
          referenceType: input.referenceType || null,
          referenceId: input.referenceId || null,
          createdBy: input.createdBy,
          updatedAt: now,
        },
        include: {
          createdByUser: {
            select: { name: true, email: true },
          },
        },
      });

      await tx.notificationUser.createMany({
        data: notificationUsers,
        skipDuplicates: true,
      });

      return createdNotification;
    });

    for (const notificationUser of notificationUsers) {
      emitNotificationEvent({
        userId: notificationUser.userId,
        companyId: input.companyId,
        notification: formatNotification({
          ...notificationUser,
          notification,
        }),
      });
    }

    return notification;
  }

  static async createRequestNotification(input: CreateNotificationInput) {
    try {
      return await NotificationService.createNotification(input);
    } catch (error) {
      console.error('Failed to create notification', error);
      return null;
    }
  }

  static async fetchForUser(params: {
    userId: string;
    companyId: string;
    status?: string;
    limit: number;
    offset: number;
  }) {
    const status = normalizeStatus(params.status);
    const where = {
      userId: params.userId,
      companyId: params.companyId,
      ...(status === 'ALL' ? {} : { status }),
    };

    const [count, rows] = await Promise.all([
      prisma.notificationUser.count({ where }),
      prisma.notificationUser.findMany({
        where,
        include: {
          notification: {
            include: {
              createdByUser: {
                select: { name: true, email: true },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: params.offset,
        take: params.limit,
      }),
    ]);

    return {
      data: rows.map(formatNotification),
      count,
      limit: params.limit,
      offset: params.offset,
      status,
    };
  }

  static async updateUserNotificationStatus(params: {
    userId: string;
    companyId: string;
    notificationUserId?: string;
    notificationId?: string;
    status?: string;
  }) {
    const status = normalizeStatus(params.status || 'READ');
    const nextStatus = status === 'ALL' ? 'READ' : status;
    const where = {
      userId: params.userId,
      companyId: params.companyId,
      ...(params.notificationUserId
        ? { id: params.notificationUserId }
        : { notificationId: params.notificationId }),
    };

    await prisma.notificationUser.updateMany({
      where,
      data: { status: nextStatus },
    });

    const rows = await prisma.notificationUser.findMany({
      where,
      include: {
        notification: {
          include: {
            createdByUser: {
              select: { name: true, email: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map(formatNotification);
  }
}

export class NotificationDbController {
  static async fetch(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId, companyId, status } = req.body;
      const { offset, limit } = getPagination(req.body);

      if (!userId || !companyId) {
        return res.status(400).json({ error: 'userId and companyId required' });
      }

      const result = await NotificationService.fetchForUser({
        userId,
        companyId,
        status,
        limit,
        offset,
      });

      return res.status(200).json(result);
    } catch (error) {
      return next(error);
    }
  }

  static async markRead(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        userId,
        companyId,
        notificationUserId,
        notificationId,
        id,
        status,
      } = req.body;

      if (!userId || !companyId) {
        return res.status(400).json({ error: 'userId and companyId required' });
      }

      const targetNotificationUserId = notificationUserId || id;
      if (!targetNotificationUserId && !notificationId) {
        return res
          .status(400)
          .json({ error: 'notificationUserId or notificationId required' });
      }

      const data = await NotificationService.updateUserNotificationStatus({
        userId,
        companyId,
        notificationUserId: targetNotificationUserId,
        notificationId,
        status,
      });

      return res.status(200).json({
        message: 'Notification status updated',
        data,
      });
    } catch (error) {
      return next(error);
    }
  }
}
