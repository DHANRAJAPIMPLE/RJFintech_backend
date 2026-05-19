import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { emitNotificationEvent } from '../../../shared/utils/notification-events.util';
import { getPagination } from '../../../shared/utils/pagination.util';
import { prisma } from '../../lib/prisma';

type NotificationType = 'INITIATE' | 'APPROVE' | 'REJECT';
type NotificationReferenceType = 'USER' | 'ORG' | 'WORKFLOW' | 'COMPANY';

type CreateNotificationInput = {
  companyId: string;
  name?: string;
  message?: string;
  type: NotificationType;
  referenceType?: NotificationReferenceType | null;
  referenceId?: string | null;
  referenceName?: string | null;
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

const getDisplayValue = (value: unknown, fallback: string) => {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized || fallback;
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

    if (!input.referenceType && (!input.name || !input.message)) {
      throw new Error('name and message are required');
    }
  }

  private static getActorName(user: { name?: string | null; email?: string }) {
    return getDisplayValue(user.name, getDisplayValue(user.email, 'Someone'));
  }

  private static getRequestNotificationContent(
    input: CreateNotificationInput,
    actorName: string,
  ) {
    const userName = getDisplayValue(input.referenceName, 'the user');
    const orgName = getDisplayValue(input.referenceName, 'the organization');
    const workflowName = getDisplayValue(input.referenceName, 'the workflow');
    const companyName = getDisplayValue(input.referenceName, 'the company');

    switch (`${input.referenceType}:${input.type}`) {
      case 'USER:INITIATE':
        return {
          name: 'User onboarding initiated',
          message: `${actorName} initiated user onboarding for ${userName}`,
        };
      case 'USER:APPROVE':
        return {
          name: 'User onboarding approved',
          message: `${actorName} approved user onboarding for ${userName}`,
        };
      case 'USER:REJECT':
        return {
          name: 'User onboarding rejected',
          message: `${actorName} rejected user onboarding for ${userName}`,
        };
      case 'ORG:INITIATE':
        return {
          name: 'Organization request initiated',
          message: `${actorName} initiated organization request for ${orgName}`,
        };
      case 'ORG:APPROVE':
        return {
          name: 'Organization request approved',
          message: `${actorName} approved organization request for ${orgName}`,
        };
      case 'ORG:REJECT':
        return {
          name: 'Organization request rejected',
          message: `${actorName} rejected organization request for ${orgName}`,
        };
      case 'WORKFLOW:INITIATE':
        return {
          name: 'Workflow request initiated',
          message: `${actorName} initiated workflow request for ${workflowName}`,
        };
      case 'WORKFLOW:APPROVE':
        return {
          name: 'Workflow request approved',
          message: `${actorName} approved workflow request for ${workflowName}`,
        };
      case 'WORKFLOW:REJECT':
        return {
          name: 'Workflow request rejected',
          message: `${actorName} rejected workflow request for ${workflowName}`,
        };
      case 'COMPANY:INITIATE':
        return {
          name: 'Company onboarding initiated',
          message: `${actorName} initiated company onboarding for ${companyName}`,
        };
      case 'COMPANY:APPROVE':
        return {
          name: 'Company onboarding approved',
          message: `${actorName} approved company onboarding for ${companyName}`,
        };
      case 'COMPANY:REJECT':
        return {
          name: 'Company onboarding rejected',
          message: `${actorName} rejected company onboarding for ${companyName}`,
        };
      default:
        return {
          name: input.name || 'Notification',
          message: input.message || `${actorName} updated a notification`,
        };
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

    const [saasAdmins, createdByUser] = await Promise.all([
      NotificationService.getSaasAdminUserIds(input.companyId),
      prisma.user.findUnique({
        where: { id: input.createdBy },
        select: { name: true, email: true },
      }),
    ]);
    const actorName = NotificationService.getActorName(createdByUser || {});
    const content = NotificationService.getRequestNotificationContent(
      input,
      actorName,
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
          name: content.name,
          message: content.message,
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
