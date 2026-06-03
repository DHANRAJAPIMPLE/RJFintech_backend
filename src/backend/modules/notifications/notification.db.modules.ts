import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { emitNotificationEvent } from '../../../shared/utils/notification-events.util';
import { getPagination } from '../../../shared/utils/pagination.util';
import { prisma } from '../../lib/prisma';

type NotificationType =
  | 'INITIATE'
  | 'APPROVE'
  | 'REJECT'
  | 'ONBOARDED'
  | 'MODIFICATION'
  | 'ACTIVE'
  | 'INACTIVE'
  | 'ARCHIVE';
type NotificationReferenceType = 'USER' | 'ORG' | 'WORKFLOW' | 'COMPANY';
type NotificationFetchDateRange =
  | 'ALL'
  | '7_DAYS'
  | '15_DAYS'
  | '1_MONTH'
  | 'CUSTOM';

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
  includeCreatedBy?: boolean;
};

const SUPPORTED_NOTIFICATION_TYPES: NotificationType[] = [
  'INITIATE',
  'APPROVE',
  'REJECT',
  'ONBOARDED',
  'MODIFICATION',
  'ACTIVE',
  'INACTIVE',
  'ARCHIVE',
];
const SUPPORTED_REFERENCE_TYPES: NotificationReferenceType[] = [
  'USER',
  'ORG',
  'WORKFLOW',
  'COMPANY',
];
const PENDING_NOTIFICATION_TYPES: NotificationType[] = [
  'INITIATE',
  'MODIFICATION',
  'ACTIVE',
  'INACTIVE',
  'ARCHIVE',
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

const normalizeReferenceType = (value: unknown) => {
  const referenceType =
    typeof value === 'string' ? value.trim().toUpperCase() : '';
  const normalizedReferenceType = referenceType as NotificationReferenceType;
  return SUPPORTED_REFERENCE_TYPES.includes(normalizedReferenceType)
    ? normalizedReferenceType
    : null;
};

const normalizeDateRange = (value: unknown): NotificationFetchDateRange => {
  let dateRange = typeof value === 'string' ? value.trim().toUpperCase() : 'ALL';
  if (typeof value === 'string') {
    dateRange = dateRange.replace(/[\s-]+/g, '_');
    if (dateRange === '7DAYS') dateRange = '7_DAYS';
    if (dateRange === '15DAYS') dateRange = '15_DAYS';
    if (dateRange === '1MONTH') dateRange = '1_MONTH';
  }
  return ['ALL', '7_DAYS', '15_DAYS', '1_MONTH', 'CUSTOM'].includes(
    dateRange,
  )
    ? (dateRange as NotificationFetchDateRange)
    : 'ALL';
};

const normalizeDateValue = (value: unknown) => {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const normalizeCursorId = (value: unknown) => {
  if (typeof value !== 'string') return null;
  const cursorId = value.trim();
  return cursorId || null;
};

const formatDateTime = (value: Date | string | null | undefined): string => {
  if (!value) return 'N/A';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';

  const pad = (input: number) => String(input).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

const getDisplayValue = (value: unknown, fallback: string) => {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized || fallback;
};

const isUuidLike = (value: unknown) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value.trim(),
  );

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

  static mergeRecipientUserIds(
    ...groups: Array<
      string | null | undefined | Array<string | null | undefined>
    >
  ) {
    return NotificationService.unique(
      groups.flatMap((group) => (Array.isArray(group) ? group : [group])),
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

  private static isPendingNotificationType(type: NotificationType) {
    return PENDING_NOTIFICATION_TYPES.includes(type);
  }

  private static stringifyTargetParts(parts: Array<string | null | undefined>) {
    const values = parts
      .map((part) => (typeof part === 'string' ? part.trim() : ''))
      .filter(Boolean);
    return values.length > 0 ? values.join(', ') : null;
  }

  private static async resolveNotificationTarget(row: {
    companyId: string;
    referenceType?: string | null;
    referenceId?: string | null;
  }) {
    const referenceType =
      typeof row.referenceType === 'string'
        ? row.referenceType.trim().toUpperCase()
        : '';
    const referenceId =
      typeof row.referenceId === 'string' ? row.referenceId.trim() : '';
    if (!referenceType || !referenceId) return null;

    if (referenceType === 'USER') {
      const onboarding = await prisma.userOnboarding.findUnique({
        where: { id: referenceId },
        select: {
          data: true,
        },
      });

      const data = onboarding?.data as any;
      return (
        (typeof data?.targetUserEmail === 'string' && data.targetUserEmail.trim()) ||
        (typeof data?.basicDetails?.email === 'string' &&
          data.basicDetails.email.trim()) ||
        null
      );
    }

    if (referenceType === 'ORG') {
      const request = await prisma.orgStructureReq.findUnique({
        where: { id: referenceId },
        select: {
          data: true,
        },
      });

      const data = request?.data as any;
      return (
        (typeof data?.targetNodePath === 'string' &&
          data.targetNodePath.trim()) ||
        (typeof data?.nodePath === 'string' && data.nodePath.trim()) ||
        (typeof data?.currentData?.nodePath === 'string' &&
          data.currentData.nodePath.trim()) ||
        null
      );
    }

    if (referenceType === 'WORKFLOW') {
      if (isUuidLike(referenceId)) {
        const request = await prisma.workflowReq.findUnique({
          where: { id: referenceId },
          select: {
            nodeId: true,
            module: true,
            subModule: true,
            levelsHash: true,
            data: true,
          },
        });

        if (request) {
          const orgNode = await prisma.orgStructure.findUnique({
            where: { id: request.nodeId },
            select: { nodePath: true },
          });
          const requestData = request.data as any;
          const nodePath =
            (typeof requestData?.nodePath === 'string' &&
              requestData.nodePath.trim()) ||
            orgNode?.nodePath ||
            null;
          return NotificationService.stringifyTargetParts([
            nodePath,
            request.levelsHash,
            request.module,
            request.subModule,
          ]);
        }
      }

      const workflow = await prisma.workflow.findFirst({
        where: {
          companyId: row.companyId,
          levelsHash: referenceId,
        },
        orderBy: { createdAt: 'desc' },
        select: {
          module: true,
          subModule: true,
          levelsHash: true,
          orgStructure: { select: { nodePath: true } },
        },
      });

      if (workflow) {
        return NotificationService.stringifyTargetParts([
          workflow.orgStructure?.nodePath || null,
          workflow.levelsHash,
          workflow.module,
          workflow.subModule,
        ]);
      }
    }

    return null;
  }

  private static async formatNotification(
    row: any,
    target?: string | null,
  ) {
    const resolvedTarget =
      target === undefined
        ? await NotificationService.resolveNotificationTarget(row.notification)
        : target;

    return {
      id: row.id,
      name: row.notification.name,
      message: row.notification.message,
      type: row.notification.type,
      refType: row.notification.referenceType,
      referenceId: row.notification.referenceId,
      target: resolvedTarget,
      isPending: row.notification.isPending ?? false,
      status: row.status,
      createdByname: row.notification.createdByUser?.name || null,
      createdByemail: row.notification.createdByUser?.email || null,
      ['createat_timestamp']: formatDateTime(row.notification.createdAt),
    };
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

    const content = (() => {
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
      case 'USER:ONBOARDED':
        return {
          name: 'User onboarded',
          message: `${actorName} onboarded ${userName}`,
        };
      case 'USER:MODIFICATION':
        return {
          name: 'User modification',
          message: `${actorName} updated user access for ${userName}`,
        };
      case 'USER:ACTIVE':
        return {
          name: 'User activated',
          message: `${actorName} activated ${userName}`,
        };
      case 'USER:INACTIVE':
        return {
          name: 'User inactivated',
          message: `${actorName} inactivated ${userName}`,
        };
      case 'USER:ARCHIVE':
        return {
          name: 'User archived',
          message: `${actorName} archived ${userName}`,
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
      case 'ORG:ONBOARDED':
        return {
          name: 'Organization structure onboarded',
          message: `${actorName} onboarded organization structure for ${orgName}`,
        };
      case 'ORG:MODIFICATION':
        return {
          name: 'Organization modification',
          message: `${actorName} updated organization structure for ${orgName}`,
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
      case 'WORKFLOW:ONBOARDED':
        return {
          name: 'Workflow onboarded',
          message: `${actorName} onboarded workflow ${workflowName}`,
        };
      case 'WORKFLOW:MODIFICATION':
        return {
          name: 'Workflow modification',
          message: `${actorName} updated workflow ${workflowName}`,
        };
      case 'WORKFLOW:ACTIVE':
        return {
          name: 'Workflow activated',
          message: `${actorName} activated workflow ${workflowName}`,
        };
      case 'WORKFLOW:INACTIVE':
        return {
          name: 'Workflow inactivated',
          message: `${actorName} inactivated workflow ${workflowName}`,
        };
      case 'WORKFLOW:ARCHIVE':
        return {
          name: 'Workflow archived',
          message: `${actorName} archived workflow ${workflowName}`,
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
      case 'COMPANY:ONBOARDED':
        return {
          name: 'Company onboarded',
          message: `${actorName} onboarded ${companyName}`,
        };
      default:
        return {
          name: 'Notification',
          message: `${actorName} updated a notification`,
        };
      }
    })();

    return {
      name: input.name || content.name,
      message: input.message || content.message,
    };
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

  private static async getSaasAdminUserIds() {
    const accesses = await prisma.userAccess.findMany({
      where: {
        roleCode: 'SAAS_ADMIN',
        user: {
          userMappings: {
            some: { status: 'ACTIVE' },
          },
        },
      },
      select: { userId: true },
    });

    return NotificationService.unique(accesses.map((access) => access.userId));
  }

  private static async canReadAllCompanyNotifications(
    userId: string,
    requested?: boolean,
  ) {
    if (!requested) return false;

    const access = await prisma.userAccess.findFirst({
      where: {
        userId,
        roleCode: 'SAAS_ADMIN',
        user: {
          userMappings: {
            some: { status: 'ACTIVE' },
          },
        },
      },
      select: { id: true },
    });

    return Boolean(access);
  }

  static async getCorpAdminUserIds(companyId: string) {
    const accesses = await prisma.userAccess.findMany({
      where: {
        companyId,
        roleCode: 'CORP_ADMIN',
        user: {
          userMappings: {
            some: { companyId, status: 'ACTIVE' },
          },
        },
      },
      select: { userId: true },
    });

    return NotificationService.unique(accesses.map((access) => access.userId));
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

  static async getRequestInitiatorId(reqId: string, reqTable: string) {
    const config = NotificationService.getHistoryConfig(reqTable);
    if (!config) return null;

    const row = await (prisma as any)[config.table].findFirst({
      where: { [config.field]: reqId, event: 'INITIATE' },
      orderBy: { createdAt: 'asc' },
      select: { eventUserId: true },
    });

    return row?.eventUserId || null;
  }

  static async getCompanyRequestInitiatorId(companyCode?: string | null) {
    if (!companyCode) return null;

    const row = await prisma.companyHistory.findFirst({
      where: { companyCode, event: 'INITIATE' },
      orderBy: { createdAt: 'desc' },
      select: { eventUserId: true },
    });

    return row?.eventUserId || null;
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
      NotificationService.getSaasAdminUserIds(),
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
    const isPending = NotificationService.isPendingNotificationType(input.type);
    const shouldClearPreviousPending =
      !isPending && Boolean(input.referenceType) && Boolean(input.referenceId);
    const duplicateWindowStart = new Date(Date.now() - 2 * 60 * 1000);
    const requestedRecipients = NotificationService.unique(
      [
        ...(input.recipientUserIds || []),
        input.includeCreatedBy === true ? input.createdBy : null,
      ],
    );
    const companyRecipientUserIds =
      await NotificationService.filterActiveCompanyUserIds(
        input.companyId,
        requestedRecipients,
      );
    const recipientUserIds = NotificationService.unique([
      ...companyRecipientUserIds,
      ...saasAdmins,
    ]).filter(
      (userId) => input.includeCreatedBy === true || userId !== input.createdBy,
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
      if (shouldClearPreviousPending) {
        await tx.notification.updateMany({
          where: {
            companyId: input.companyId,
            referenceType: input.referenceType || null,
            referenceId: input.referenceId || null,
            isPending: true,
          },
          data: {
            isPending: false,
            updatedAt: now,
          },
        });
      }

      const existingNotification = await tx.notification.findFirst({
        where: {
          companyId: input.companyId,
          type: input.type,
          referenceType: input.referenceType || null,
          referenceId: input.referenceId || null,
          createdBy: input.createdBy,
          name: content.name,
          message: content.message,
          createdAt: { gte: duplicateWindowStart },
        },
        orderBy: { createdAt: 'desc' },
        include: {
          createdByUser: {
            select: { name: true, email: true },
          },
        },
      });

      if (existingNotification) {
        return { notification: existingNotification, shouldEmit: false };
      }

      const createdNotification = await tx.notification.create({
        data: {
          id: notificationId,
          companyId: input.companyId,
          name: content.name,
          message: content.message,
          type: input.type,
          referenceType: input.referenceType || null,
          referenceId: input.referenceId || null,
          isPending,
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

      return { notification: createdNotification, shouldEmit: true };
    });

    const target = await NotificationService.resolveNotificationTarget(
      notification.notification,
    );

    if (notification.shouldEmit) {
      for (const notificationUser of notificationUsers) {
        const formattedNotification = await NotificationService.formatNotification(
          {
            ...notificationUser,
            notification: notification.notification,
          },
          target,
        );
        emitNotificationEvent({
          userId: notificationUser.userId,
          companyId: input.companyId,
          notification: formattedNotification,
        });
      }
    }

    return notification.notification;
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
    refType?: string | null;
    dateRange?: string;
    fromDate?: string | Date;
    toDate?: string | Date;
    limit: number;
    offset: number;
    cursorId?: string | null;
    includeAllCompanies?: boolean;
  }) {
    const status = normalizeFetchStatus(params.status);
    const referenceType = normalizeReferenceType(params.refType);
    const dateRange = normalizeDateRange(params.dateRange);
    const fromDate = normalizeDateValue(params.fromDate);
    const toDate = normalizeDateValue(params.toDate);
    const cursorId = normalizeCursorId(params.cursorId);
    const includeAllCompanies =
      await NotificationService.canReadAllCompanyNotifications(
        params.userId,
        params.includeAllCompanies,
      );
    const notificationWhere: any = {};

    if (referenceType) {
      notificationWhere.referenceType = referenceType;
    }

    if (dateRange !== 'ALL') {
      if (dateRange === '7_DAYS') {
        notificationWhere.createdAt = {
          ...(notificationWhere.createdAt || {}),
          gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        };
      } else if (dateRange === '15_DAYS') {
        notificationWhere.createdAt = {
          ...(notificationWhere.createdAt || {}),
          gte: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000),
        };
      } else if (dateRange === '1_MONTH') {
        const monthAgo = new Date();
        monthAgo.setMonth(monthAgo.getMonth() - 1);
        notificationWhere.createdAt = {
          ...(notificationWhere.createdAt || {}),
          gte: monthAgo,
        };
      } else if (dateRange === 'CUSTOM') {
        if (!fromDate || !toDate) {
          throw new Error('fromDate and toDate are required for custom date range');
        }

        notificationWhere.createdAt = {
          ...(notificationWhere.createdAt || {}),
          gte: fromDate,
          lte: toDate,
        };
      }
    }

    const baseWhere: any = {
      userId: params.userId,
      ...(includeAllCompanies ? {} : { companyId: params.companyId }),
      ...(Object.keys(notificationWhere).length
        ? { notification: notificationWhere }
        : {}),
    };
    const where: any = {
      ...baseWhere,
      ...(status === 'ALL' ? {} : { status }),
    };
    const unreadWhere: any = {
      ...baseWhere,
      status: 'UNREAD',
    };

    const [unreadCount, allCount, cursorRow] = await Promise.all([
      prisma.notificationUser.count({ where: unreadWhere }),
      prisma.notificationUser.count({ where: baseWhere }),
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
        count: unreadCount,
        unreadCount,
        allCount,
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
      data: await Promise.all(
        pageRows.map((row) => NotificationService.formatNotification(row)),
      ),
      count: unreadCount,
      unreadCount,
      allCount,
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
    includeAllCompanies?: boolean;
  }) {
    const status = normalizeStatus(params.status || 'READ');
    const nextStatus = status === 'ALL' ? 'READ' : status;
    const includeAllCompanies =
      await NotificationService.canReadAllCompanyNotifications(
        params.userId,
        params.includeAllCompanies,
      );
    const where = {
      userId: params.userId,
      ...(includeAllCompanies ? {} : { companyId: params.companyId }),
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

    return Promise.all(
      rows.map((row) => NotificationService.formatNotification(row)),
    );
  }
}

export class NotificationDbController {
  static async fetch(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        userId,
        companyId,
        status,
        refType,
        dateRange,
        fromDate,
        toDate,
        cursorId,
      } = req.body;
      const { offset, limit } = getPagination(req.body);

      if (!userId || !companyId) {
        return res.status(400).json({ error: 'userId and companyId required' });
      }

      const result = await NotificationService.fetchForUser({
        userId,
        companyId,
        status,
        refType,
        dateRange,
        fromDate,
        toDate,
        limit,
        offset,
        cursorId,
        includeAllCompanies: req.body?.includeAllCompanies === true,
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
        includeAllCompanies: req.body?.includeAllCompanies === true,
      });

      return res.status(200).json({
        message: 'Notification status updated'
      });
    } catch (error) {
      return next(error);
    }
  }
}
