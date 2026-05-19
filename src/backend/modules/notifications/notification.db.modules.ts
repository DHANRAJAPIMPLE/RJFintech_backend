import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { emitNotificationEvent } from '../../../shared/utils/notification-events.util';
import { getPagination } from '../../../shared/utils/pagination.util';
import { prisma } from '../../lib/prisma';

type NotificationType = 'INITIATE' | 'APPROVE' | 'REJECT';
type NotificationReferenceType = 'USER' | 'ORG' | 'WORKFLOW' | 'COMPANY';

type CreateNotificationInput = {
  companyId: string;
  name: string;
  message: string;
  type: NotificationType;
  referenceType?: NotificationReferenceType | null;
  referenceId?: string | null;
  createdBy: string;
  recipientUserIds?: string[];
};

const SUPPORTED_NOTIFICATION_TYPES: NotificationType[] = [
  'INITIATE',
  'APPROVE',
  'REJECT',
];
const SUPPORTED_REFERENCE_TYPES: NotificationReferenceType[] = [
  'USER',
  'ORG',
  'WORKFLOW',
  'COMPANY',
];

const normalizeStatus = (value: unknown) => {
  const status = typeof value === 'string' ? value.trim().toUpperCase() : 'ALL';
  return ['READ', 'UNREAD', 'ARCHIVED', 'ALL'].includes(status)
    ? status
    : 'ALL';
};

const normalizeFetchStatus = (value: unknown) => {
  const status = typeof value === 'string' ? value.trim().toUpperCase() : 'ALL';
  return ['READ', 'UNREAD', 'ALL'].includes(status) ? status : 'ALL';
};

const normalizeCursorId = (value: unknown) => {
  if (typeof value !== 'string') return null;
  const cursorId = value.trim();
  return cursorId || null;
};

const formatNotification = (row: any) => ({
  id: row.id,
  name: row.notification.name,
  message: row.notification.message,
  type: row.notification.type,
  refType: row.notification.referenceType,
  referenceId: row.notification.referenceId,
  status: row.status,
  createdByname: row.notification.createdByUser?.name || null,
  createdByemail: row.notification.createdByUser?.email || null,
  ['createat_timestamp']: row.notification.createdAt,
});

export class NotificationService {
  private static unique(values: Array<string | null | undefined>) {
    return Array.from(
      new Set(
        values
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    );
  }

  private static validateNotificationInput(input: CreateNotificationInput) {
    if (!input.companyId || !input.createdBy) {
      throw new Error('companyId and createdBy are required');
    }

    if (!SUPPORTED_NOTIFICATION_TYPES.includes(input.type)) {
      throw new Error(`Unsupported notification type: ${input.type}`);
    }

    if (
      input.referenceType &&
      !SUPPORTED_REFERENCE_TYPES.includes(input.referenceType)
    ) {
      throw new Error(
        `Unsupported notification reference type: ${input.referenceType}`,
      );
    }
  }

  private static async filterActiveCompanyUserIds(
    companyId: string,
    userIds: string[],
  ) {
    const uniqueUserIds = NotificationService.unique(userIds);
    if (uniqueUserIds.length === 0) return [];

    const mappings = await prisma.userMapping.findMany({
      where: {
        companyId,
        userId: { in: uniqueUserIds },
        status: 'ACTIVE',
      },
      select: { userId: true },
    });

    return NotificationService.unique(
      mappings.map((mapping) => mapping.userId),
    );
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

  private static getHistoryConfig(reqTable: string) {
    switch (reqTable) {
      case 'user_onboarding':
        return { table: 'userHistory', field: 'reqId' };
      case 'org_structure_req':
        return { table: 'orgHistory', field: 'orgReqId' };
      case 'workflow_req':
        return { table: 'workflowReqHistory', field: 'workflowReqId' };
      default:
        return null;
    }
  }

  private static async getExcludedApproverIds(reqId: string, reqTable: string) {
    const config = NotificationService.getHistoryConfig(reqTable);
    if (!config) return [];

    const [initiatorLog, approvalLogs] = await Promise.all([
      (prisma as any)[config.table].findFirst({
        where: { [config.field]: reqId, event: 'INITIATE' },
        select: { eventUserId: true },
      }),
      (prisma as any)[config.table].findMany({
        where: { [config.field]: reqId, event: 'APPROVED' },
        select: { eventUserId: true },
      }),
    ]);

    return NotificationService.unique([
      initiatorLog?.eventUserId,
      ...approvalLogs.map((log: any) => log.eventUserId),
    ]);
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

    if (!Array.isArray(currentLevel?.approversList)) {
      return NotificationService.unique(fallbackUserIds);
    }

    const excludedApproverIds = new Set(
      await NotificationService.getExcludedApproverIds(reqId, reqTable),
    );

    return NotificationService.unique(
      currentLevel.approversList as string[],
    ).filter((userId) => !excludedApproverIds.has(userId));
  }

  static async createNotification(input: CreateNotificationInput) {
    NotificationService.validateNotificationInput(input);

    const saasAdmins = await NotificationService.getSaasAdminUserIds(
      input.companyId,
    );
    const requestedRecipients = NotificationService.unique([
      ...(input.recipientUserIds || []),
      ...saasAdmins,
    ]).filter((userId) => userId !== input.createdBy);
    const recipientUserIds =
      await NotificationService.filterActiveCompanyUserIds(
        input.companyId,
        requestedRecipients,
      );

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
    cursorId?: string | null;
  }) {
    const status = normalizeFetchStatus(params.status);
    const cursorId = normalizeCursorId(params.cursorId);
    const where: any = {
      userId: params.userId,
      companyId: params.companyId,
      ...(status === 'ALL' ? {} : { status }),
    };

    const [count, cursorRow] = await Promise.all([
      prisma.notificationUser.count({ where }),
      cursorId
        ? prisma.notificationUser.findFirst({
            where: { ...where, id: cursorId },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);

    if (cursorId && !cursorRow) {
      return {
        data: [],
        count,
        limit: params.limit,
        offset: params.offset,
        status,
        cursorId,
        nextCursorId: null,
        hasNextPage: false,
      };
    }

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
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(cursorId
        ? { cursor: { id: cursorId }, skip: 1 }
        : { skip: params.offset }),
      take: params.limit + 1,
    });

    const hasNextPage = rows.length > params.limit;
    const pageRows = hasNextPage ? rows.slice(0, params.limit) : rows;
    const nextCursorId = hasNextPage
      ? pageRows[pageRows.length - 1]?.id || null
      : null;

    return {
      data: pageRows.map(formatNotification),
      count,
      limit: params.limit,
      offset: cursorId ? 0 : params.offset,
      status,
      cursorId,
      nextCursorId,
      hasNextPage,
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
      const { userId, companyId, status, cursorId } = req.body;
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
        cursorId,
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
