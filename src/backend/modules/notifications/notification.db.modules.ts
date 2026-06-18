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
  | 'ARCHIVE'
  | 'AUTO_DELETE';
type NotificationReferenceType = 'USER' | 'ORG' | 'WORKFLOW' | 'COMPANY';
type NotificationModule = 'USER' | 'WORKFLOW' | 'ORG';
type NotificationVisibilityStatus = 'UNREAD' | 'READ' | 'ARCHIVED' | 'HIDDEN';
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
  requiredRecipientUserIds?: string[];
  includeCreatedBy?: boolean;
  isPending?: boolean;
};

type NotificationSettingsFetchParams = {
  userId: string;
  companyId: string;
  includeAllCompanies?: boolean;
};

type NotificationSettingsUpdateParams = {
  userId: string;
  companyId: string;
  eventUserId: string;
  companies: Array<{
    companyCode: string;
    settings: Array<{
      nodePath: string;
      module: NotificationModule;
      isEnabled: boolean;
      remarks?: string | null;
    }>;
  }>;
  includeAllCompanies?: boolean;
};

type NotificationAccessNode = {
  id: string;
  nodeName: string;
  nodePath: string;
  levelCount: number;
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
  'AUTO_DELETE',
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
const NOTIFICATION_MODULES: NotificationModule[] = ['USER', 'WORKFLOW', 'ORG'];

const normalizeStatus = (value: unknown) => {
  const status = typeof value === 'string' ? value.trim().toUpperCase() : 'ALL';
  return ['READ', 'UNREAD', 'ARCHIVED', 'ALL'].includes(status)
    ? status
    : 'ALL';
};

const normalizeFetchStatus = (value: unknown) => {
  const status = typeof value === 'string' ? value.trim().toUpperCase() : 'ALL';
  return ['READ', 'UNREAD', 'HIDDEN', 'ALL'].includes(status) ? status : 'ALL';
};

const getNodeLevelCount = (nodePath: unknown) => {
  if (typeof nodePath !== 'string') return 1;
  const segments = nodePath
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);
  return Math.max(segments.length, 1);
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

  private static async resolveNotificationPendingState(row: {
    companyId: string;
    type?: string | null;
    referenceType?: string | null;
    referenceId?: string | null;
    isPending?: boolean | null;
  }) {
    if (row.isPending !== true) {
      return false;
    }

    const referenceType =
      typeof row.referenceType === 'string'
        ? row.referenceType.trim().toUpperCase()
        : '';
    const referenceId =
      typeof row.referenceId === 'string' ? row.referenceId.trim() : '';

    if (!referenceType || !referenceId) return false;

    if (referenceType === 'USER') {
      const onboarding = await prisma.userOnboarding.findUnique({
        where: { id: referenceId },
        select: { status: true },
      });

      return onboarding?.status === 'PENDING';
    }

    if (referenceType === 'ORG') {
      const request = await prisma.orgStructureReq.findUnique({
        where: { id: referenceId },
        select: { status: true },
      });

      return request?.status === 'PENDING';
    }

    if (referenceType === 'WORKFLOW' && isUuidLike(referenceId)) {
      const request = await prisma.workflowReq.findUnique({
        where: { id: referenceId },
        select: { status: true },
      });

      return request?.status === 'PENDING';
    }

    if (referenceType === 'COMPANY' && isUuidLike(referenceId)) {
      const request = await prisma.companyOnboarding.findUnique({
        where: { id: referenceId },
        select: { status: true },
      });

      return request?.status === 'PENDING';
    }

    return false;
  }

  private static async hidePendingNotificationUsers(
    tx: any,
    params: {
      companyId: string;
      referenceType?: string | null;
      referenceId?: string | null;
      now: Date;
      excludeNotificationId?: string | null;
    },
  ) {
    const pendingNotifications = await tx.notification.findMany({
      where: {
        companyId: params.companyId,
        referenceType: params.referenceType || null,
        referenceId: params.referenceId || null,
        isPending: true,
        ...(params.excludeNotificationId
          ? { id: { not: params.excludeNotificationId } }
          : {}),
      },
      select: { id: true },
    });
    const pendingNotificationIds = pendingNotifications.map(
      (notification: any) => notification.id,
    );

    if (pendingNotificationIds.length === 0) return;

    await tx.notificationUser.updateMany({
      where: {
        notificationId: { in: pendingNotificationIds },
        status: { not: 'HIDDEN' },
      },
      data: {
        status: 'HIDDEN',
        updatedAt: params.now,
      },
    });

    await tx.notification.updateMany({
      where: {
        id: { in: pendingNotificationIds },
      },
      data: {
        isPending: false,
        updatedAt: params.now,
      },
    });
  }

  private static async formatNotification(
    row: any,
    target?: string | null,
  ) {
    const resolvedTarget =
      target === undefined
        ? await NotificationService.resolveNotificationTarget(row.notification)
        : target;
    const resolvedPendingState =
      await NotificationService.resolveNotificationPendingState(
        row.notification,
      );

    return {
      id: row.id,
      name: row.notification.name,
      message: row.notification.message,
      type: row.notification.type,
      refType: row.notification.referenceType,
      referenceId: row.notification.referenceId,
      target: resolvedTarget,
      isPending: resolvedPendingState,
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
          name: 'User deleted',
          message: `${actorName} deleted ${userName}`,
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
      case 'ORG:INACTIVE':
        return {
          name: 'Organization Removed',
          message: `${actorName} inactivated organization ${orgName}`,
        };
      case 'ORG:ARCHIVE':
        return {
          name: 'Organization deleted',
          message: `${actorName} deleted organization ${orgName}`,
        };
      case 'ORG:AUTO_DELETE':
        return {
          name: 'Organization auto-deleted',
          message: `${actorName} auto-deleted organization ${orgName}`,
        };
      case 'ORG:ACTIVE':
        return {
          name: 'Organization activated',
          message: `${actorName} activated organization ${orgName}`,
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
          name: 'Workflow deleted',
          message: `${actorName} deleted workflow ${workflowName}`,
        };
      case 'WORKFLOW:AUTO_DELETE':
        return {
          name: 'Workflow auto-deleted',
          message: `${actorName} auto-deleted workflow ${workflowName}`,
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

  private static async filterExistingUserIds(userIds: string[]) {
    const uniqueUserIds = NotificationService.unique(userIds);
    if (uniqueUserIds.length === 0) return [];

    const users = await prisma.user.findMany({
      where: { id: { in: uniqueUserIds } },
      select: { id: true },
    });

    return NotificationService.unique(users.map((user) => user.id));
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

  private static normalizeNotificationModule(
    value: unknown,
  ): NotificationModule | null {
    const moduleName =
      typeof value === 'string' ? value.trim().toUpperCase() : '';
    return NOTIFICATION_MODULES.includes(moduleName as NotificationModule)
      ? (moduleName as NotificationModule)
      : null;
  }

  private static getNotificationModuleForReferenceType(
    referenceType?: string | null,
  ): NotificationModule | null {
    const normalized = String(referenceType || '').trim().toUpperCase();
    if (normalized === 'USER') return 'USER';
    if (normalized === 'WORKFLOW') return 'WORKFLOW';
    if (normalized === 'ORG') return 'ORG';
    return null;
  }

  private static buildNotificationSettingsHistoryPayload(input: {
    nodePath: string;
    nodeName: string;
    module: NotificationModule;
    isEnabled: boolean;
    remarks?: string | null;
  }) {
    return {
      nodePath: input.nodePath,
      nodeName: input.nodeName,
      module: input.module,
      isEnabled: input.isEnabled,
      remarks: input.remarks ?? null,
    };
  }

  private static buildNotificationSettingsHistoryRemark(input: {
    module: NotificationModule;
    nodeName: string;
    nodePath: string;
    isEnabled: boolean;
  }) {
    const action = input.isEnabled ? 'enabled' : 'disabled';
    return `Notification setting ${action} for ${input.module} on ${input.nodeName} (${input.nodePath}).`;
  }

  private static async getAccessibleCompanyRows(
    userId: string,
    companyId: string,
    includeAllCompanies?: boolean,
  ) {
    const allowAll =
      await NotificationService.canReadAllCompanyNotifications(
        userId,
        includeAllCompanies,
      );

    return prisma.userMapping.findMany({
      where: {
        userId,
        status: 'ACTIVE',
        ...(allowAll ? {} : { companyId }),
      },
      select: {
        companyId: true,
        company: {
          select: {
            id: true,
            companyCode: true,
            legalName: true,
            brandName: true,
          },
        },
      },
      orderBy: {
        company: { companyCode: 'asc' },
      },
    });
  }

  private static async getAccessibleNotificationNodes(
    tx: any,
    companyId: string,
    userId: string,
  ): Promise<NotificationAccessNode[]> {
    const hasGlobalAccess = Boolean(
      await tx.userAccess.findFirst({
        where: {
          companyId,
          userId,
          isGlobalAccess: true,
          orgStructure: {
            status: 'ACTIVE',
          },
        },
        select: { id: true },
      }),
    );

    if (hasGlobalAccess) {
      const nodes = await tx.orgStructure.findMany({
        where: {
          companyId,
          status: 'ACTIVE',
        },
        select: {
          id: true,
          nodeName: true,
          nodePath: true,
        },
        orderBy: { nodePath: 'asc' },
      });

      return nodes.map((node: any) => ({
        ...node,
        levelCount: getNodeLevelCount(node.nodePath),
      }));
    }

    const accesses = await tx.userAccess.findMany({
      where: {
        companyId,
        userId,
        orgStructure: {
          status: 'ACTIVE',
        },
      },
      select: {
        nodeId: true,
        orgStructure: {
          select: {
            id: true,
            nodeName: true,
            nodePath: true,
          },
        },
      },
      orderBy: {
        orgStructure: { nodePath: 'asc' },
      },
    });

    const uniqueNodes = new Map<string, NotificationAccessNode>();
    accesses.forEach((access: any) => {
      const node = access.orgStructure;
      if (!node?.id) return;
      uniqueNodes.set(node.id, {
        id: node.id,
        nodeName: node.nodeName,
        nodePath: node.nodePath,
        levelCount: getNodeLevelCount(node.nodePath),
      });
    });

    return Array.from(uniqueNodes.values()).sort((left, right) =>
      left.nodePath.localeCompare(right.nodePath),
    );
  }

  static async syncNotificationSettingsForUserAccess(
    tx: any,
    params: {
      companyId: string;
      userId: string;
      eventUserId: string;
      createReason: string;
      removeReason: string;
    },
  ) {
    const mapping = await tx.userMapping.findFirst({
      where: {
        companyId: params.companyId,
        userId: params.userId,
      },
      select: { status: true },
    });

    const nodeRows =
      mapping?.status === 'ACTIVE'
        ? await NotificationService.getAccessibleNotificationNodes(
            tx,
            params.companyId,
            params.userId,
          )
        : [];
    const nodeMap = new Map(nodeRows.map((node) => [node.id, node]));

    const existingRows = await (tx as any).notificationSetting.findMany({
      where: {
        companyId: params.companyId,
        userId: params.userId,
      },
      include: {
        node: {
          select: {
            nodeName: true,
            nodePath: true,
          },
        },
      },
    });

    const desiredKeys = new Set<string>();
    nodeRows.forEach((node) => {
      NOTIFICATION_MODULES.forEach((module) => {
        desiredKeys.add(`${node.id}:${module}`);
      });
    });

    for (const existing of existingRows) {
      const node = existing.node;
      const existingKey = `${existing.nodeId}:${existing.module}`;
      if (desiredKeys.has(existingKey)) continue;

      const oldData = node
        ? NotificationService.buildNotificationSettingsHistoryPayload({
            nodePath: node.nodePath,
            nodeName: node.nodeName,
            module: NotificationService.normalizeNotificationModule(
              existing.module,
            ) || 'USER',
            isEnabled: Boolean(existing.isEnabled),
            remarks: null,
          })
        : null;

      await (tx as any).notificationSettingHistory.create({
        data: {
          notificationSettingId: existing.id,
          companyId: params.companyId,
          eventUserId: params.eventUserId,
          oldData,
          newData: null,
          remarks: params.removeReason,
        },
      });

      await (tx as any).notificationSetting.delete({
        where: { id: existing.id },
      });
    }

    const existingKeySet = new Set(
      existingRows.map((row: any) => `${row.nodeId}:${row.module}`),
    );

    for (const node of nodeRows) {
      for (const module of NOTIFICATION_MODULES) {
        const key = `${node.id}:${module}`;
        if (existingKeySet.has(key)) continue;

        const created = await (tx as any).notificationSetting.create({
          data: {
            companyId: params.companyId,
            userId: params.userId,
            nodeId: node.id,
            module,
            isEnabled: true,
          },
        });

        await (tx as any).notificationSettingHistory.create({
          data: {
            notificationSettingId: created.id,
            companyId: params.companyId,
            eventUserId: params.eventUserId,
            oldData: null,
            newData: NotificationService.buildNotificationSettingsHistoryPayload(
              {
                nodePath: node.nodePath,
                nodeName: node.nodeName,
                module,
                isEnabled: true,
                remarks: params.createReason,
              },
            ),
            remarks: params.createReason,
          },
        });
      }
    }
  }

  private static async resolveNotificationNodeIds(
    tx: any,
    input: {
      companyId: string;
      referenceType?: string | null;
      referenceId?: string | null;
    },
  ) {
    const module = NotificationService.getNotificationModuleForReferenceType(
      input.referenceType,
    );
    if (!module) {
      return { module: null, nodeIds: [] as string[] };
    }

    const referenceId =
      typeof input.referenceId === 'string' ? input.referenceId.trim() : '';
    if (!referenceId) {
      return { module, nodeIds: [] as string[] };
    }

    if (module === 'WORKFLOW') {
      if (isUuidLike(referenceId)) {
        const request = await tx.workflowReq.findUnique({
          where: { id: referenceId },
          select: {
            nodeId: true,
            data: true,
          },
        });
        const nodeId =
          typeof request?.nodeId === 'string' && request.nodeId
            ? request.nodeId
            : null;
        if (nodeId) {
          return { module, nodeIds: [nodeId] };
        }

        const nodePath = (request?.data as any)?.nodePath;
        if (typeof nodePath === 'string' && nodePath.trim()) {
          const node = await tx.orgStructure.findFirst({
            where: {
              companyId: input.companyId,
              nodePath: nodePath.trim(),
            },
            select: { id: true },
          });
          return { module, nodeIds: node?.id ? [node.id] : [] };
        }
      }

      return { module, nodeIds: [] as string[] };
    }

    if (module === 'ORG') {
      const request = await tx.orgStructureReq.findUnique({
        where: { id: referenceId },
        select: { data: true },
      });
      const data = request?.data as any;
      const nodePath =
        (typeof data?.targetNodePath === 'string' && data.targetNodePath) ||
        (typeof data?.nodePath === 'string' && data.nodePath) ||
        (typeof data?.currentData?.nodePath === 'string' &&
          data.currentData.nodePath) ||
        null;
      if (!nodePath) return { module, nodeIds: [] as string[] };

      const node = await tx.orgStructure.findFirst({
        where: {
          companyId: input.companyId,
          nodePath,
        },
        select: { id: true },
      });

      return { module, nodeIds: node?.id ? [node.id] : [] };
    }

    const request = await tx.userOnboarding.findUnique({
      where: { id: referenceId },
      select: {
        data: true,
        oldData: true,
      },
    });

    const candidatePaths = new Set<string>();
    const collectPermissionPaths = (value: unknown) => {
      if (!Array.isArray(value)) return;
      value.forEach((permission: any) => {
        const path =
          typeof permission?.nodePath === 'string' ? permission.nodePath.trim() : '';
        if (path) candidatePaths.add(path);
      });
    };

    const data = request?.data as any;
    const oldData = request?.oldData as any;
    collectPermissionPaths(data?.permissions);
    collectPermissionPaths(oldData?.permissions);

    if (candidatePaths.size === 0) {
      const targetEmail =
        (typeof data?.targetUserEmail === 'string' && data.targetUserEmail) ||
        (typeof data?.basicDetails?.email === 'string' &&
          data.basicDetails.email) ||
        null;

      if (targetEmail) {
        const targetUser = await tx.user.findUnique({
          where: { email: targetEmail },
          select: { id: true },
        });

        if (targetUser?.id) {
          const accesses = await tx.userAccess.findMany({
            where: {
              companyId: input.companyId,
              userId: targetUser.id,
            },
            select: { nodeId: true },
          });

          return {
            module,
            nodeIds: NotificationService.unique(
              accesses.map((access: any) => access.nodeId),
            ),
          };
        }
      }
    }

    if (candidatePaths.size === 0) {
      return { module, nodeIds: [] as string[] };
    }

    const nodes = await tx.orgStructure.findMany({
      where: {
        companyId: input.companyId,
        nodePath: { in: Array.from(candidatePaths) },
      },
      select: { id: true },
    });

    return {
      module,
      nodeIds: NotificationService.unique(nodes.map((node: any) => node.id)),
    };
  }

  private static async resolveHiddenRecipientUserIds(
    tx: any,
    params: {
      companyId: string;
      recipientUserIds: string[];
      referenceType?: string | null;
      referenceId?: string | null;
    },
  ) {
    const context = await NotificationService.resolveNotificationNodeIds(tx, {
      companyId: params.companyId,
      referenceType: params.referenceType,
      referenceId: params.referenceId,
    });

    if (!context.module || context.nodeIds.length === 0) {
      return new Set<string>();
    }

    const disabledRows = await (tx as any).notificationSetting.findMany({
      where: {
        companyId: params.companyId,
        userId: { in: params.recipientUserIds },
        nodeId: { in: context.nodeIds },
        module: context.module,
        isEnabled: false,
      },
      select: {
        userId: true,
        nodeId: true,
      },
    });

    const disabledByUser = new Map<string, Set<string>>();
    disabledRows.forEach((row: any) => {
      const current = disabledByUser.get(row.userId) || new Set<string>();
      current.add(row.nodeId);
      disabledByUser.set(row.userId, current);
    });

    const hiddenUserIds = new Set<string>();
    params.recipientUserIds.forEach((userId) => {
      const disabledNodeIds = disabledByUser.get(userId);
      if (!disabledNodeIds) return;
      const isHiddenForAllNodes = context.nodeIds.every((nodeId) =>
        disabledNodeIds.has(nodeId),
      );
      if (isHiddenForAllNodes) {
        hiddenUserIds.add(userId);
      }
    });

    return hiddenUserIds;
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

  static async getReportingManagerUserIds(
    companyId: string,
    userId?: string | null,
    subModule?: string | null,
  ) {
    if (!userId) return [];

    const mapping = await prisma.userMapping.findFirst({
      where: {
        companyId,
        userId,
        status: 'ACTIVE',
      },
      select: { reportingManager: true },
    });

    if (!mapping?.reportingManager) return [];

    const managerAccesses = await prisma.userAccess.findMany({
      where: {
        companyId,
        userId: mapping.reportingManager,
        user: {
          userMappings: {
            some: {
              companyId,
              status: 'ACTIVE',
            },
          },
        },
        OR: [
          { isGlobalAccess: true },
          ...(subModule
            ? [
                { role: { subCategory: subModule, approve: true } },
                { role: { subCategory: subModule, view: true } },
              ]
            : []),
        ],
      },
      select: { userId: true },
    });

    return NotificationService.unique(
      managerAccesses.map((access) => access.userId),
    );
  }

  private static getHistoryConfig(reqTable: string) {
    switch (reqTable) {
      case 'user_onboarding':
        return {
          table: 'userHistory',
          field: 'reqId',
          requestTable: 'userOnboarding',
        };
      case 'org_structure_req':
        return {
          table: 'orgHistory',
          field: 'orgReqId',
          requestTable: 'orgStructureReq',
        };
      case 'workflow_req':
        return {
          table: 'workflowReqHistory',
          field: 'workflowReqId',
          requestTable: 'workflowReq',
        };
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

    if (row?.eventUserId) return row.eventUserId;

    const request = await (prisma as any)[config.requestTable].findUnique({
      where: { id: reqId },
      select: { initiatorId: true },
    });

    return request?.initiatorId || null;
  }

  static async getRequestInitiatorReportingManagerIds(
    companyId: string,
    reqId: string,
    reqTable: string,
  ) {
    const initiatorId = await NotificationService.getRequestInitiatorId(
      reqId,
      reqTable,
    );

    const subModuleByReqTable: Record<string, string> = {
      user_onboarding: 'USER_ACC',
      org_structure_req: 'ORG_STR',
      workflow_req: 'WORK_FLOW',
    };

    return NotificationService.getReportingManagerUserIds(
      companyId,
      initiatorId,
      subModuleByReqTable[reqTable] || null,
    );
  }

  static async getRequestApproverIds(reqId: string, reqTable: string) {
    const config = NotificationService.getHistoryConfig(reqTable);
    if (!config) return [];

    const rows = await prisma.workflowApprover.findMany({
      where: { reqId, reqTable },
      select: { approversList: true },
    });
    const approverIds = rows.flatMap((row) =>
      Array.isArray(row.approversList) ? (row.approversList as string[]) : [],
    );

    if (approverIds.length > 0) {
      return NotificationService.unique(approverIds);
    }

    const request = await (prisma as any)[config.requestTable].findUnique({
      where: { id: reqId },
      select: { eligibleApprovers: true },
    });

    return NotificationService.unique(request?.eligibleApprovers || []);
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
    const isPending =
      input.isPending ?? NotificationService.isPendingNotificationType(input.type);
    const shouldClearPreviousPending =
      Boolean(input.referenceType) && Boolean(input.referenceId);
    const duplicateWindowStart = new Date(Date.now() - 2 * 60 * 1000);
    const requestedRecipients = NotificationService.unique(
      [
        ...(input.recipientUserIds || []),
        input.includeCreatedBy === true ? input.createdBy : null,
      ],
    );
    const [companyRecipientUserIds, requiredRecipientUserIds] =
      await Promise.all([
        NotificationService.filterActiveCompanyUserIds(
          input.companyId,
          requestedRecipients,
        ),
        NotificationService.filterExistingUserIds(
          input.requiredRecipientUserIds || [],
        ),
      ]);
    const requiredRecipientSet = new Set(requiredRecipientUserIds);
    const recipientUserIds = NotificationService.unique([
      ...companyRecipientUserIds,
      ...requiredRecipientUserIds,
      ...saasAdmins,
    ]).filter(
      (userId) =>
        input.includeCreatedBy === true ||
        requiredRecipientSet.has(userId) ||
        userId !== input.createdBy,
    );

    if (recipientUserIds.length === 0) return null;

    const notificationId = randomUUID();
    const now = new Date();

    const notification = await prisma.$transaction(async (tx) => {
      const hiddenRecipientUserIds =
        await NotificationService.resolveHiddenRecipientUserIds(tx, {
          companyId: input.companyId,
          recipientUserIds,
          referenceType: input.referenceType,
          referenceId: input.referenceId,
        });
      const notificationUsers = recipientUserIds.map((userId) => ({
        id: randomUUID(),
        companyId: input.companyId,
        userId,
        notificationId,
        status: (
          hiddenRecipientUserIds.has(userId) ? 'HIDDEN' : 'UNREAD'
        ) as NotificationVisibilityStatus,
        updatedAt: now,
      }));
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
        if (shouldClearPreviousPending) {
          await NotificationService.hidePendingNotificationUsers(tx, {
            companyId: input.companyId,
            referenceType: input.referenceType,
            referenceId: input.referenceId,
            now,
            excludeNotificationId: existingNotification.id,
          });
        }

        const updatedNotification =
          existingNotification.isPending === isPending
            ? existingNotification
            : await tx.notification.update({
                where: { id: existingNotification.id },
                data: {
                  isPending,
                  updatedAt: now,
                },
                include: {
                  createdByUser: {
                    select: { name: true, email: true },
                  },
                },
              });

        return {
          notification: updatedNotification,
          shouldEmit: false,
          notificationUsers: [] as typeof notificationUsers,
        };
      }

      if (shouldClearPreviousPending) {
        await NotificationService.hidePendingNotificationUsers(tx, {
          companyId: input.companyId,
          referenceType: input.referenceType,
          referenceId: input.referenceId,
          now,
        });
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

      return {
        notification: createdNotification,
        shouldEmit: true,
        notificationUsers,
      };
    });

    const target = await NotificationService.resolveNotificationTarget(
      notification.notification,
    );

    if (notification.shouldEmit) {
      for (const notificationUser of notification.notificationUsers) {
        if (notificationUser.status === 'HIDDEN') continue;
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

    const scopedWhere: any = {
      userId: params.userId,
      ...(includeAllCompanies ? {} : { companyId: params.companyId }),
      ...(Object.keys(notificationWhere).length
        ? { notification: notificationWhere }
        : {}),
    };
    const visibleBaseWhere: any = {
      ...scopedWhere,
      status: { not: 'HIDDEN' },
    };
    const hiddenWhere: any = {
      ...scopedWhere,
      status: 'HIDDEN',
    };
    const where: any = {
      ...scopedWhere,
      ...(status === 'HIDDEN'
        ? { status: 'HIDDEN' }
        : status === 'ALL'
          ? { status: { not: 'HIDDEN' } }
          : { status }),
    };
    const unreadWhere: any = {
      ...visibleBaseWhere,
      status: 'UNREAD',
    };

    const [unreadCount, allCount, hiddenCount, currentStatusCount, cursorRow] =
      await Promise.all([
        prisma.notificationUser.count({ where: unreadWhere }),
        prisma.notificationUser.count({ where: visibleBaseWhere }),
        prisma.notificationUser.count({ where: hiddenWhere }),
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
        count: currentStatusCount,
        unreadCount,
        allCount,
        hiddenCount,
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
      count: currentStatusCount,
      unreadCount,
      allCount,
      hiddenCount,
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

  static async fetchSettingsForUser(params: NotificationSettingsFetchParams) {
    const mappings = await NotificationService.getAccessibleCompanyRows(
      params.userId,
      params.companyId,
      params.includeAllCompanies,
    );
    if (mappings.length === 0) {
      return { success: true, data: [] as any[] };
    }

    const companyIds = mappings.map((mapping) => mapping.companyId);
    const [settingsRows, globalAccessRows, accessRows, allOrgNodes] =
      await Promise.all([
        (prisma as any).notificationSetting.findMany({
          where: {
            userId: params.userId,
            companyId: { in: companyIds },
          },
          include: {
            node: {
              select: {
                id: true,
                nodeName: true,
                nodePath: true,
              },
            },
          },
        }),
        prisma.userAccess.findMany({
          where: {
            userId: params.userId,
            companyId: { in: companyIds },
            isGlobalAccess: true,
            orgStructure: { status: 'ACTIVE' },
          },
          select: { companyId: true },
        }),
        prisma.userAccess.findMany({
          where: {
            userId: params.userId,
            companyId: { in: companyIds },
            orgStructure: { status: 'ACTIVE' },
          },
          select: {
            companyId: true,
            nodeId: true,
            orgStructure: {
              select: {
                id: true,
                nodeName: true,
                nodePath: true,
              },
            },
          },
        }),
        prisma.orgStructure.findMany({
          where: {
            companyId: { in: companyIds },
            status: 'ACTIVE',
          },
          select: {
            companyId: true,
            id: true,
            nodeName: true,
            nodePath: true,
          },
          orderBy: { nodePath: 'asc' },
        }),
      ]);

    const globalCompanyIds = new Set(
      globalAccessRows.map((row) => String(row.companyId || '').trim()),
    );
    const settingsByKey = new Map<string, any>();
    settingsRows.forEach((row: any) => {
      settingsByKey.set(
        `${row.companyId}:${row.nodeId}:${row.module}`,
        row,
      );
    });

    const directNodesByCompany = new Map<string, Map<string, NotificationAccessNode>>();
    accessRows.forEach((row: any) => {
      const companyKey = String(row.companyId || '').trim();
      const node = row.orgStructure;
      if (!companyKey || !node?.id) return;
      const companyNodes =
        directNodesByCompany.get(companyKey) || new Map<string, NotificationAccessNode>();
      companyNodes.set(node.id, {
        id: node.id,
        nodeName: node.nodeName,
        nodePath: node.nodePath,
        levelCount: getNodeLevelCount(node.nodePath),
      });
      directNodesByCompany.set(companyKey, companyNodes);
    });

    const allNodesByCompany = new Map<string, NotificationAccessNode[]>();
    allOrgNodes.forEach((node: any) => {
      const companyKey = String(node.companyId || '').trim();
      const current = allNodesByCompany.get(companyKey) || [];
      current.push({
        id: node.id,
        nodeName: node.nodeName,
        nodePath: node.nodePath,
        levelCount: getNodeLevelCount(node.nodePath),
      });
      allNodesByCompany.set(companyKey, current);
    });

    const data = mappings.map((mapping) => {
      const companyKey = mapping.companyId;
      const visibleNodes = globalCompanyIds.has(companyKey)
        ? allNodesByCompany.get(companyKey) || []
        : Array.from(directNodesByCompany.get(companyKey)?.values() || []).sort(
            (left, right) => left.nodePath.localeCompare(right.nodePath),
          );

      return {
        companyName:
          mapping.company.brandName || mapping.company.legalName || null,
        companyCode: mapping.company.companyCode,
        nodes: visibleNodes.map((node) => ({
          nodePath: node.nodePath,
          nodeName: node.nodeName,
          levelCount: node.levelCount,
          settings: NOTIFICATION_MODULES.map((module) => {
            const row = settingsByKey.get(
              `${companyKey}:${node.id}:${module}`,
            );
            return {
              module,
              isEnabled:
                typeof row?.isEnabled === 'boolean' ? row.isEnabled : true,
            };
          }),
        })),
      };
    });

    return { success: true, data };
  }

  static async updateSettingsForUser(params: NotificationSettingsUpdateParams) {
    const mappings = await NotificationService.getAccessibleCompanyRows(
      params.userId,
      params.companyId,
      params.includeAllCompanies,
    );
    const mappingByCode = new Map(
      mappings.map((mapping) => [mapping.company.companyCode, mapping]),
    );

    const updated = await prisma.$transaction(async (tx) => {
      const results: any[] = [];

      for (const companyEntry of params.companies) {
        const mapping = mappingByCode.get(companyEntry.companyCode);
        if (!mapping) {
          throw new Error(
            `Company ${companyEntry.companyCode} is not accessible for this user`,
          );
        }

        const accessibleNodes =
          await NotificationService.getAccessibleNotificationNodes(
            tx,
            mapping.companyId,
            params.userId,
          );
        const accessibleNodeByPath = new Map(
          accessibleNodes.map((node) => [node.nodePath, node]),
        );

        for (const setting of companyEntry.settings) {
          const module = NotificationService.normalizeNotificationModule(
            setting.module,
          );
          if (!module) {
            throw new Error(`Unsupported notification module: ${setting.module}`);
          }

          const node = accessibleNodeByPath.get(setting.nodePath);
          if (!node) {
            throw new Error(
              `Node path ${setting.nodePath} is not accessible for company ${companyEntry.companyCode}`,
            );
          }

          const existing = await (tx as any).notificationSetting.findFirst({
            where: {
              companyId: mapping.companyId,
              userId: params.userId,
              nodeId: node.id,
              module,
            },
          });

          const oldData = existing
            ? NotificationService.buildNotificationSettingsHistoryPayload({
                nodePath: node.nodePath,
                nodeName: node.nodeName,
                module,
                isEnabled: Boolean(existing.isEnabled),
                remarks: null,
              })
            : null;

          if (
            existing &&
            Boolean(existing.isEnabled) === setting.isEnabled
          ) {
            continue;
          }

          if (!existing && setting.isEnabled === true) {
            continue;
          }

          const saved = existing
            ? await (tx as any).notificationSetting.update({
                where: { id: existing.id },
                data: {
                  isEnabled: setting.isEnabled,
                },
              })
            : await (tx as any).notificationSetting.create({
                data: {
                  companyId: mapping.companyId,
                  userId: params.userId,
                  nodeId: node.id,
                  module,
                  isEnabled: setting.isEnabled,
                },
              });

          const newData =
            NotificationService.buildNotificationSettingsHistoryPayload({
              nodePath: node.nodePath,
              nodeName: node.nodeName,
              module,
              isEnabled: setting.isEnabled,
              remarks: null,
            });
          const historyRemark =
            NotificationService.buildNotificationSettingsHistoryRemark({
              module,
              nodeName: node.nodeName,
              nodePath: node.nodePath,
              isEnabled: setting.isEnabled,
            });

          await (tx as any).notificationSettingHistory.create({
            data: {
              notificationSettingId: saved.id,
              companyId: mapping.companyId,
              eventUserId: params.eventUserId,
              oldData,
              newData,
              remarks: historyRemark,
            },
          });

          results.push({
            companyCode: companyEntry.companyCode,
            nodePath: node.nodePath,
            nodeName: node.nodeName,
            module,
            isEnabled: setting.isEnabled,
          });
        }
      }

      return results;
    });

    return {
      success: true,
      message: 'Notification settings updated successfully',
      data: updated,
    };
  }
}

export class NotificationDbController {
  static async fetchSettings(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId, companyId } = req.body;

      if (!userId || !companyId) {
        return res.status(400).json({ error: 'userId and companyId required' });
      }

      const result = await NotificationService.fetchSettingsForUser({
        userId,
        companyId,
        includeAllCompanies: req.body?.includeAllCompanies === true,
      });

      return res.status(200).json(result);
    } catch (error) {
      return next(error);
    }
  }

  static async updateSettings(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId, companyId, eventUserId, companies } = req.body;

      if (!userId || !companyId || !eventUserId) {
        return res
          .status(400)
          .json({ error: 'userId, companyId and eventUserId required' });
      }

      if (!Array.isArray(companies) || companies.length === 0) {
        return res.status(400).json({ error: 'companies array is required' });
      }

      const result = await NotificationService.updateSettingsForUser({
        userId,
        companyId,
        eventUserId,
        companies,
        includeAllCompanies: req.body?.includeAllCompanies === true,
      });

      return res.status(200).json(result);
    } catch (error) {
      return next(error);
    }
  }

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
