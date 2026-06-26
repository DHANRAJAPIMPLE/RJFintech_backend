import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { emitNotificationEvent } from '../../../shared/utils/notification-events.util';
import { getPagination } from '../../../shared/utils/pagination.util';
import { HistoryUserUtil } from '../../utils/history-user.util';
import { prisma } from '../../lib/prisma';

type NotificationType =
  | 'Pending Approval - INITIATE'
  | 'Pending Approval - MODIFICATION'
  | 'Pending Approval - ACTIVE'
  | 'Pending Approval - INACTIVE'
  | 'Pending Approval - ARCHIVED'
  | 'APPROVED'
  | 'ONBOARDED'
  | 'MODIFIED'
  | 'ACTIVATED'
  | 'INACTIVATED'
  | 'ARCHIVED'
  | 'REJECTED-INITIATE'
  | 'REJECTED-MODIFICATION'
  | 'REJECTED-ACTIVE'
  | 'REJECTED-INACTIVE'
  | 'REJECTED-ARCHIVED'
  | 'FAILED'
  | 'AUTO_DELETE';
type LegacyNotificationType =
  | 'INITIATE'
  | 'APPROVE'
  | 'REJECT'
  | 'MODIFICATION'
  | 'ACTIVE'
  | 'INACTIVE'
  | 'ARCHIVE';
type NotificationReferenceType = 'USER' | 'ORG' | 'WORKFLOW' | 'COMPANY';
type NotificationModule = 'USER' | 'WORKFLOW' | 'ORG' | 'COMPANY';
type NotificationVisibilityStatus = 'UNREAD' | 'READ' | 'ARCHIVED' | 'HIDDEN';
type NotificationFetchDateRange =
  | 'ALL'
  | '7_DAYS'
  | '15_DAYS'
  | '1_MONTH'
  | 'CUSTOM';

type NotificationFilterOption = {
  label: string;
  value: string;
  count: number;
};

type CreateNotificationInput = {
  companyId: string;
  name?: string;
  message?: string;
  type: NotificationType | LegacyNotificationType;
  referenceType?: NotificationReferenceType | null;
  referenceId?: string | null;
  referenceName?: string | null;
  createdBy: string;
  recipientUserIds?: string[];
  requiredRecipientUserIds?: string[];
  includeCreatedBy?: boolean;
  isPending?: boolean;
};

type NormalizedCreateNotificationInput = Omit<CreateNotificationInput, 'type'> & {
  type: NotificationType;
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
  nodeType: string;
  levelCount: number;
};

type NotificationAccessScopeNode = NotificationAccessNode & {
  modules: NotificationModule[];
};

const SUPPORTED_NOTIFICATION_TYPES: NotificationType[] = [
  'Pending Approval - INITIATE',
  'Pending Approval - MODIFICATION',
  'Pending Approval - ACTIVE',
  'Pending Approval - INACTIVE',
  'Pending Approval - ARCHIVED',
  'APPROVED',
  'ONBOARDED',
  'MODIFIED',
  'ACTIVATED',
  'INACTIVATED',
  'ARCHIVED',
  'REJECTED-INITIATE',
  'REJECTED-MODIFICATION',
  'REJECTED-ACTIVE',
  'REJECTED-INACTIVE',
  'REJECTED-ARCHIVED',
  'FAILED',
  'AUTO_DELETE',
];
const SUPPORTED_REFERENCE_TYPES: NotificationReferenceType[] = [
  'USER',
  'ORG',
  'WORKFLOW',
  'COMPANY',
];
const PENDING_NOTIFICATION_TYPES: NotificationType[] = [
  'Pending Approval - INITIATE',
  'Pending Approval - MODIFICATION',
  'Pending Approval - ACTIVE',
  'Pending Approval - INACTIVE',
  'Pending Approval - ARCHIVED',
];
const NOTIFICATION_MODULES: NotificationModule[] = [
  'USER',
  'WORKFLOW',
  'ORG',
  'COMPANY',
];
const NOTIFICATION_MODULE_TO_SUBCATEGORY: Record<
  Exclude<NotificationModule, 'COMPANY'>,
  'USER_ACC' | 'WORK_FLOW' | 'ORG_STR'
> = {
  USER: 'USER_ACC',
  WORKFLOW: 'WORK_FLOW',
  ORG: 'ORG_STR',
};

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

const normalizeFetchStatusValues = (value: unknown) => {
  const values =
    typeof value === 'string'
      ? value.includes(',')
        ? value.split(',')
        : [value]
      : Array.isArray(value)
        ? value
        : [];

  const statuses = Array.from(
    new Set(
      values
        .map((item) => (typeof item === 'string' ? item.trim().toUpperCase() : ''))
        .filter((item) => ['READ', 'UNREAD', 'HIDDEN'].includes(item)),
    ),
  );

  return statuses.length > 0 ? statuses : null;
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

const normalizeReferenceTypes = (value: unknown): NotificationReferenceType[] => {
  const values =
    typeof value === 'string'
      ? value.includes(',')
        ? value.split(',')
        : [value]
      : Array.isArray(value)
        ? value
        : [];

  return Array.from(
    new Set(
      values
        .map((item) => normalizeReferenceType(item))
        .filter((item): item is NotificationReferenceType => Boolean(item)),
    ),
  );
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

const normalizeNotificationFetchTypes = (value: unknown): NotificationType[] => {
  const values =
    typeof value === 'string'
      ? value.includes(',')
        ? value.split(',')
        : [value]
      : Array.isArray(value)
        ? value
        : [];

  return Array.from(
    new Set(
      values
        .flatMap((item) => {
          const normalized =
            typeof item === 'string' ? item.trim().toUpperCase() : '';
          if (!normalized || normalized === 'ALL') return [];

          if (normalized === 'INITIATE') return ['Pending Approval - INITIATE'];
          if (normalized === 'MODIFICATION' || normalized === 'UPDATE') {
            return ['Pending Approval - MODIFICATION'];
          }
          if (normalized === 'ACTIVE') return ['Pending Approval - ACTIVE'];
          if (normalized === 'INACTIVE') return ['Pending Approval - INACTIVE'];
          if (normalized === 'ARCHIVE') return ['Pending Approval - ARCHIVED'];

          return [normalizeNotificationTypeValue(normalized, false)];
        })
        .filter((type): type is NotificationType =>
          SUPPORTED_NOTIFICATION_TYPES.includes(type as NotificationType),
        ),
    ),
  );
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

const canonicalPendingTypeByRequestType: Record<string, NotificationType> = {
  INITIATE: 'Pending Approval - INITIATE',
  UPDATE: 'Pending Approval - MODIFICATION',
  MODIFICATION: 'Pending Approval - MODIFICATION',
  ACTIVE: 'Pending Approval - ACTIVE',
  INACTIVE: 'Pending Approval - INACTIVE',
  ARCHIVE: 'Pending Approval - ARCHIVED',
  ARCHIVED: 'Pending Approval - ARCHIVED',
};

const normalizeNotificationTypeValue = (
  type: unknown,
  isPending: boolean,
): NotificationType => {
  const normalized = typeof type === 'string' ? type.trim().toUpperCase() : '';

  if (
    normalized === 'PENDING APPROVAL - INITIATE' ||
    normalized === 'PENDING_APPROVAL_INITIATE'
  ) {
    return 'Pending Approval - INITIATE';
  }
  if (
    normalized === 'PENDING APPROVAL - MODIFICATION' ||
    normalized === 'PENDING APPROVAL - UPDATE' ||
    normalized === 'PENDING_APPROVAL_MODIFICATION' ||
    normalized === 'PENDING_APPROVAL_UPDATE'
  ) {
    return 'Pending Approval - MODIFICATION';
  }
  if (
    normalized === 'PENDING APPROVAL - ACTIVE' ||
    normalized === 'PENDING_APPROVAL_ACTIVE'
  ) {
    return 'Pending Approval - ACTIVE';
  }
  if (
    normalized === 'PENDING APPROVAL - INACTIVE' ||
    normalized === 'PENDING_APPROVAL_INACTIVE'
  ) {
    return 'Pending Approval - INACTIVE';
  }
  if (
    normalized === 'PENDING APPROVAL - ARCHIVE' ||
    normalized === 'PENDING APPROVAL - ARCHIVED' ||
    normalized === 'PENDING_APPROVAL_ARCHIVE' ||
    normalized === 'PENDING_APPROVAL_ARCHIVED'
  ) {
    return 'Pending Approval - ARCHIVED';
  }

  if (normalized === 'APPROVE' || normalized === 'APPROVED') {
    return 'APPROVED';
  }
  if (normalized === 'ONBOARDED') return 'ONBOARDED';
  if (normalized === 'MODIFIED') return 'MODIFIED';
  if (normalized === 'ACTIVATED') return 'ACTIVATED';
  if (normalized === 'INACTIVATED') return 'INACTIVATED';
  if (normalized === 'ARCHIVED') return 'ARCHIVED';
  if (normalized === 'FAILED') return 'FAILED';
  if (normalized === 'AUTO_DELETE') return 'AUTO_DELETE';

  if (
    normalized === 'REJECTED-INITIATE' ||
    normalized === 'REJECTED_INITIATE'
  ) {
    return 'REJECTED-INITIATE';
  }
  if (
    normalized === 'REJECTED-MODIFICATION' ||
    normalized === 'REJECTED_MODIFICATION' ||
    normalized === 'REJECTED-UPDATE' ||
    normalized === 'REJECTED_UPDATE'
  ) {
    return 'REJECTED-MODIFICATION';
  }
  if (normalized === 'REJECTED-ACTIVE' || normalized === 'REJECTED_ACTIVE') {
    return 'REJECTED-ACTIVE';
  }
  if (
    normalized === 'REJECTED-INACTIVE' ||
    normalized === 'REJECTED_INACTIVE'
  ) {
    return 'REJECTED-INACTIVE';
  }
  if (
    normalized === 'REJECTED-ARCHIVE' ||
    normalized === 'REJECTED_ARCHIVE' ||
    normalized === 'REJECTED-ARCHIVED' ||
    normalized === 'REJECTED_ARCHIVED'
  ) {
    return 'REJECTED-ARCHIVED';
  }

  if (normalized === 'REJECT' || normalized === 'REJECTED') {
    return 'REJECTED-INITIATE';
  }

  if (isPending && canonicalPendingTypeByRequestType[normalized]) {
    return canonicalPendingTypeByRequestType[normalized];
  }

  if (normalized === 'MODIFICATION' || normalized === 'UPDATE') {
    return 'MODIFIED';
  }
  if (normalized === 'ACTIVE') return 'ACTIVATED';
  if (normalized === 'INACTIVE') return 'INACTIVATED';
  if (normalized === 'ARCHIVE') return 'ARCHIVED';

  return 'ONBOARDED';
};

const getViewerNotificationTypeValue = (
  type: unknown,
  isPendingForViewer: boolean,
): NotificationType | LegacyNotificationType => {
  const normalized = typeof type === 'string' ? type.trim().toUpperCase() : '';

  if (isPendingForViewer) {
    return normalizeNotificationTypeValue(type, true);
  }

  if (
    normalized === 'PENDING APPROVAL - INITIATE' ||
    normalized === 'PENDING_APPROVAL_INITIATE'
  ) {
    return 'INITIATE';
  }
  if (
    normalized === 'PENDING APPROVAL - MODIFICATION' ||
    normalized === 'PENDING APPROVAL - UPDATE' ||
    normalized === 'PENDING_APPROVAL_MODIFICATION' ||
    normalized === 'PENDING_APPROVAL_UPDATE'
  ) {
    return 'MODIFICATION';
  }
  if (
    normalized === 'PENDING APPROVAL - ACTIVE' ||
    normalized === 'PENDING_APPROVAL_ACTIVE'
  ) {
    return 'ACTIVE';
  }
  if (
    normalized === 'PENDING APPROVAL - INACTIVE' ||
    normalized === 'PENDING_APPROVAL_INACTIVE'
  ) {
    return 'INACTIVE';
  }
  if (
    normalized === 'PENDING APPROVAL - ARCHIVE' ||
    normalized === 'PENDING APPROVAL - ARCHIVED' ||
    normalized === 'PENDING_APPROVAL_ARCHIVE' ||
    normalized === 'PENDING_APPROVAL_ARCHIVED'
  ) {
    return 'ARCHIVE';
  }

  return normalizeNotificationTypeValue(type, false);
};

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

  private static validateNotificationInput(input: NormalizedCreateNotificationInput) {
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

  private static isPendingNotificationType(
    type: NotificationType | LegacyNotificationType,
  ) {
    return PENDING_NOTIFICATION_TYPES.includes(
      normalizeNotificationTypeValue(type, true),
    );
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
      const onboardingTarget =
        (typeof data?.targetUserEmail === 'string' && data.targetUserEmail.trim()) ||
        (typeof data?.basicDetails?.email === 'string' &&
          data.basicDetails.email.trim()) ||
        null;
      if (onboardingTarget) return onboardingTarget;

      const user = await prisma.user.findUnique({
        where: { id: referenceId },
        select: { email: true },
      });

      return user?.email?.trim() || null;
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

    if (referenceType === 'COMPANY') {
      const onboarding = await prisma.companyOnboarding.findUnique({
        where: { id: referenceId },
        select: {
          companyCode: true,
          data: true,
        },
      });

      const data = onboarding?.data as any;
      return (
        (typeof data?.company?.name === 'string' &&
          data.company.name.trim()) ||
        onboarding?.companyCode?.trim() ||
        null
      );
    }

    return null;
  }

  private static async resolveNotificationPendingState(row: {
    companyId: string;
    type?: string | null;
    referenceType?: string | null;
    referenceId?: string | null;
    isPending?: boolean | null;
  }, userId?: string | null) {
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

    const normalizedUserId =
      typeof userId === 'string' ? userId.trim() : '';
    const requestTable =
      NotificationService.getRequestTableForReferenceType(referenceType);

    if (requestTable && isUuidLike(referenceId)) {
      const config = NotificationService.getHistoryConfig(requestTable);
      if (!config) return false;

      const request = await (prisma as any)[config.requestTable].findUnique({
        where: { id: referenceId },
        select: { status: true, eligibleApprovers: true },
      });

      if (request?.status !== 'PENDING') {
        return false;
      }

      if (!normalizedUserId) {
        return true;
      }

      const currentApproverIds =
        await NotificationService.getCurrentApproverIds(
          referenceId,
          requestTable,
          Array.isArray(request.eligibleApprovers)
            ? request.eligibleApprovers
            : [],
        );

      return currentApproverIds.includes(normalizedUserId);
    }

    if (referenceType === 'COMPANY' && isUuidLike(referenceId)) {
      const request = await prisma.companyOnboarding.findUnique({
        where: { id: referenceId },
        select: { status: true, eligibleApprovers: true },
      });

      if (request?.status !== 'PENDING') {
        return false;
      }

      if (!normalizedUserId) {
        return true;
      }

      return Array.isArray(request.eligibleApprovers)
        ? request.eligibleApprovers.includes(normalizedUserId)
        : false;
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
    saasAdminUserIds?: Set<string>,
  ) {
    const resolvedTarget =
      target === undefined
        ? await NotificationService.resolveNotificationTarget(row.notification)
        : target;
    const resolvedPendingState =
      await NotificationService.resolveNotificationPendingState(
        row.notification,
        row.userId,
      );
    const normalizedType = getViewerNotificationTypeValue(
      row.notification.type,
      resolvedPendingState,
    );
    const viewerUserId =
      typeof row.userId === 'string' ? row.userId.trim() : '';
    const createdByUserId =
      typeof row.notification?.createdBy === 'string'
        ? row.notification.createdBy.trim()
        : '';
    const resolvedSaasAdminUserIds =
      saasAdminUserIds ||
      (await HistoryUserUtil.getSaasAdminUserIds([
        viewerUserId,
        createdByUserId,
      ]));
    const maskedActor = HistoryUserUtil.formatAuditUser(
      row.notification.createdByUser,
      createdByUserId || null,
      resolvedSaasAdminUserIds,
      viewerUserId || null,
    );

    return {
      id: row.id,
      name: row.notification.name,
      message: row.notification.message,
      type: normalizedType,
      refType: row.notification.referenceType,
      referenceId: row.notification.referenceId,
      target: resolvedTarget,
      isPending: resolvedPendingState,
      status: row.status,
      createdByname: maskedActor.name,
      createdByemail: maskedActor.email,
      ['createat_timestamp']: formatDateTime(row.notification.createdAt),
    };
  }

  private static getActorName(user: { name?: string | null; email?: string }) {
    return getDisplayValue(user.name, getDisplayValue(user.email, 'Someone'));
  }

  private static getReferenceEntityLabel(referenceType?: string | null) {
    switch (String(referenceType || '').toUpperCase()) {
      case 'USER':
        return 'User';
      case 'ORG':
        return 'Organization';
      case 'WORKFLOW':
        return 'Workflow';
      case 'COMPANY':
        return 'Company';
      default:
        return 'Record';
    }
  }

  private static getRequestLifecycleLabel(
    referenceType?: string | null,
    normalizedType?: string | null,
  ) {
    const entity = NotificationService.getReferenceEntityLabel(referenceType);

    switch (String(normalizedType || '').toUpperCase()) {
      case 'PENDING APPROVAL - MODIFICATION':
      case 'REJECTED-MODIFICATION':
      case 'MODIFIED':
        return `${entity} modification`;
      case 'PENDING APPROVAL - ACTIVE':
      case 'REJECTED-ACTIVE':
      case 'ACTIVATED':
        return `${entity} activation`;
      case 'PENDING APPROVAL - INACTIVE':
      case 'REJECTED-INACTIVE':
      case 'INACTIVATED':
        return `${entity} inactivation`;
      case 'PENDING APPROVAL - ARCHIVED':
      case 'REJECTED-ARCHIVED':
      case 'ARCHIVED':
        return `${entity} archive`;
      default:
        return `${entity} onboarding`;
    }
  }

  private static getRequestTableForReferenceType(referenceType?: string | null) {
    switch (String(referenceType || '').toUpperCase()) {
      case 'USER':
        return 'user_onboarding';
      case 'ORG':
        return 'org_structure_req';
      case 'WORKFLOW':
        return 'workflow_req';
      default:
        return null;
    }
  }

  private static getRequestNotificationContent(
    input: CreateNotificationInput,
    _actorName: string,
  ) {
    const userName = getDisplayValue(input.referenceName, 'the user');
    const orgName = getDisplayValue(input.referenceName, 'the organization');
    const workflowName = getDisplayValue(input.referenceName, 'the workflow');
    const companyName = getDisplayValue(input.referenceName, 'the company');
    const normalizedType = normalizeNotificationTypeValue(
      input.type,
      Boolean(input.isPending),
    );
    const lifecycleLabel = NotificationService.getRequestLifecycleLabel(
      input.referenceType,
      normalizedType,
    );

    const content = (() => {
      switch (`${input.referenceType}:${normalizedType}`) {
      case 'USER:Pending Approval - INITIATE':
        return {
          name: 'User onboarding initiated',
          message: `User onboarding request initiated for ${userName}`,
        };
      case 'USER:APPROVED':
        return {
          name: 'User request approved',
          message: `User request approved for ${userName}`,
        };
      case 'USER:REJECTED-INITIATE':
        return {
          name: 'User onboarding rejected',
          message: `User onboarding request rejected for ${userName}`,
        };
      case 'USER:ONBOARDED':
        return {
          name: 'User onboarded',
          message: `${userName} was onboarded. Check the user access details for assigned roles.`,
        };
      case 'USER:Pending Approval - MODIFICATION':
        return {
          name: 'User modification initiated',
          message: `User modification request initiated for ${userName}`,
        };
      case 'USER:MODIFIED':
        return {
          name: 'User modified',
          message: `User details were modified for ${userName}`,
        };
      case 'USER:Pending Approval - ACTIVE':
        return {
          name: 'User activation initiated',
          message: `User activation request initiated for ${userName}`,
        };
      case 'USER:ACTIVATED':
        return {
          name: 'User activated',
          message: `${userName} was activated`,
        };
      case 'USER:Pending Approval - INACTIVE':
        return {
          name: 'User inactivation initiated',
          message: `User inactivation request initiated for ${userName}`,
        };
      case 'USER:INACTIVATED':
        return {
          name: 'User inactivated',
          message: `${userName} was inactivated`,
        };
      case 'USER:Pending Approval - ARCHIVED':
        return {
          name: 'User archive initiated',
          message: `User archive request initiated for ${userName}`,
        };
      case 'USER:ARCHIVED':
        return {
          name: 'User archived',
          message: `${userName} was archived`,
        };
      case 'USER:REJECTED-MODIFICATION':
        return {
          name: 'User modification rejected',
          message: `User modification request rejected for ${userName}`,
        };
      case 'USER:REJECTED-ACTIVE':
        return {
          name: 'User activation rejected',
          message: `User activation request rejected for ${userName}`,
        };
      case 'USER:REJECTED-INACTIVE':
        return {
          name: 'User inactivation rejected',
          message: `User inactivation request rejected for ${userName}`,
        };
      case 'USER:REJECTED-ARCHIVED':
        return {
          name: 'User archive rejected',
          message: `User archive request rejected for ${userName}`,
        };
      case 'USER:FAILED':
        return {
          name: 'User request failed',
          message: `User request failed for ${userName}`,
        };
      case 'ORG:Pending Approval - INITIATE':
        return {
          name: 'Organization onboarding initiated',
          message: `Organization onboarding request initiated for ${orgName}`,
        };
      case 'ORG:APPROVED':
        return {
          name: 'Organization request approved',
          message: `Organization request approved for ${orgName}`,
        };
      case 'ORG:REJECTED-INITIATE':
        return {
          name: 'Organization request rejected',
          message: `Organization onboarding request rejected for ${orgName}`,
        };
      case 'ORG:ONBOARDED':
        return {
          name: 'Organization structure onboarded',
          message: `Organization structure was onboarded for ${orgName}`,
        };
      case 'ORG:Pending Approval - MODIFICATION':
        return {
          name: 'Organization modification initiated',
          message: `Organization modification request initiated for ${orgName}`,
        };
      case 'ORG:MODIFIED':
        return {
          name: 'Organization modified',
          message: `Organization structure was modified for ${orgName}`,
        };
      case 'ORG:Pending Approval - INACTIVE':
        return {
          name: 'Organization inactivation initiated',
          message: `Organization inactivation request initiated for ${orgName}`,
        };
      case 'ORG:INACTIVATED':
        return {
          name: 'Organization inactivated',
          message: `Organization was inactivated for ${orgName}`,
        };
      case 'ORG:Pending Approval - ARCHIVED':
        return {
          name: 'Organization archive initiated',
          message: `Organization archive request initiated for ${orgName}`,
        };
      case 'ORG:ARCHIVED':
        return {
          name: 'Organization archived',
          message: `Organization was archived for ${orgName}`,
        };
      case 'ORG:AUTO_DELETE':
        return {
          name: 'Organization auto-deleted',
          message: `Organization was auto-deleted for ${orgName}`,
        };
      case 'ORG:Pending Approval - ACTIVE':
        return {
          name: 'Organization activation initiated',
          message: `Organization activation request initiated for ${orgName}`,
        };
      case 'ORG:ACTIVATED':
        return {
          name: 'Organization activated',
          message: `Organization was activated for ${orgName}`,
        };
      case 'ORG:REJECTED-MODIFICATION':
        return {
          name: 'Organization modification rejected',
          message: `Organization modification request rejected for ${orgName}`,
        };
      case 'ORG:REJECTED-ACTIVE':
        return {
          name: 'Organization activation rejected',
          message: `Organization activation request rejected for ${orgName}`,
        };
      case 'ORG:REJECTED-INACTIVE':
        return {
          name: 'Organization inactivation rejected',
          message: `Organization inactivation request rejected for ${orgName}`,
        };
      case 'ORG:REJECTED-ARCHIVED':
        return {
          name: 'Organization archive rejected',
          message: `Organization archive request rejected for ${orgName}`,
        };
      case 'ORG:FAILED':
        return {
          name: 'Organization request failed',
          message: `Organization request failed for ${orgName}`,
        };
      case 'WORKFLOW:Pending Approval - INITIATE':
        return {
          name: 'Workflow onboarding initiated',
          message: `Workflow onboarding request initiated for ${workflowName}`,
        };
      case 'WORKFLOW:APPROVED':
        return {
          name: 'Workflow request approved',
          message: `Workflow request approved for ${workflowName}`,
        };
      case 'WORKFLOW:REJECTED-INITIATE':
        return {
          name: 'Workflow request rejected',
          message: `Workflow onboarding request rejected for ${workflowName}`,
        };
      case 'WORKFLOW:ONBOARDED':
        return {
          name: 'Workflow onboarded',
          message: `Workflow was onboarded for ${workflowName}`,
        };
      case 'WORKFLOW:Pending Approval - MODIFICATION':
        return {
          name: 'Workflow modification initiated',
          message: `Workflow modification request initiated for ${workflowName}`,
        };
      case 'WORKFLOW:MODIFIED':
        return {
          name: 'Workflow modified',
          message: `Workflow was modified for ${workflowName}`,
        };
      case 'WORKFLOW:Pending Approval - ACTIVE':
        return {
          name: 'Workflow activation initiated',
          message: `Workflow activation request initiated for ${workflowName}`,
        };
      case 'WORKFLOW:ACTIVATED':
        return {
          name: 'Workflow activated',
          message: `Workflow was activated for ${workflowName}`,
        };
      case 'WORKFLOW:Pending Approval - INACTIVE':
        return {
          name: 'Workflow inactivation initiated',
          message: `Workflow inactivation request initiated for ${workflowName}`,
        };
      case 'WORKFLOW:INACTIVATED':
        return {
          name: 'Workflow inactivated',
          message: `Workflow was inactivated for ${workflowName}`,
        };
      case 'WORKFLOW:Pending Approval - ARCHIVED':
        return {
          name: 'Workflow archive initiated',
          message: `Workflow archive request initiated for ${workflowName}`,
        };
      case 'WORKFLOW:ARCHIVED':
        return {
          name: 'Workflow archived',
          message: `Workflow was archived for ${workflowName}`,
        };
      case 'WORKFLOW:AUTO_DELETE':
        return {
          name: 'Workflow auto-deleted',
          message: `Workflow was auto-deleted for ${workflowName}`,
        };
      case 'WORKFLOW:REJECTED-MODIFICATION':
        return {
          name: 'Workflow modification rejected',
          message: `Workflow modification request rejected for ${workflowName}`,
        };
      case 'WORKFLOW:REJECTED-ACTIVE':
        return {
          name: 'Workflow activation rejected',
          message: `Workflow activation request rejected for ${workflowName}`,
        };
      case 'WORKFLOW:REJECTED-INACTIVE':
        return {
          name: 'Workflow inactivation rejected',
          message: `Workflow inactivation request rejected for ${workflowName}`,
        };
      case 'WORKFLOW:REJECTED-ARCHIVED':
        return {
          name: 'Workflow archive rejected',
          message: `Workflow archive request rejected for ${workflowName}`,
        };
      case 'WORKFLOW:FAILED':
        return {
          name: 'Workflow request failed',
          message: `Workflow request failed for ${workflowName}`,
        };
      case 'COMPANY:Pending Approval - INITIATE':
        return {
          name: 'Company onboarding initiated',
          message: `Company onboarding request initiated for ${companyName}`,
        };
      case 'COMPANY:APPROVED':
        return {
          name: 'Company onboarding approved',
          message: `Company onboarding approved for ${companyName}`,
        };
      case 'COMPANY:REJECTED-INITIATE':
        return {
          name: 'Company onboarding rejected',
          message: `Company onboarding request rejected for ${companyName}`,
        };
      case 'COMPANY:ONBOARDED':
        return {
          name: 'Company onboarded',
          message: `${companyName} was onboarded`,
        };
      default:
        return {
          name: `${lifecycleLabel} updated`,
          message: `${lifecycleLabel} notification updated`,
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
    if (normalized === 'COMPANY') return 'COMPANY';
    return null;
  }

  private static getNotificationModuleForAccessSubCategory(
    subCategory?: string | null,
  ): NotificationModule | null {
    const normalized = String(subCategory || '').trim().toUpperCase();

    return (
      Object.entries(NOTIFICATION_MODULE_TO_SUBCATEGORY).find(
        ([, value]) => value === normalized,
      )?.[0] as NotificationModule | undefined
    ) || null;
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

    if (allowAll) {
      return prisma.company.findMany({
        where: {
          status: 'ACTIVE',
        },
        select: {
          id: true,
          companyCode: true,
          legalName: true,
          brandName: true,
        },
        orderBy: {
          companyCode: 'asc',
        },
      }).then((companies) =>
        companies.map((company) => ({
          companyId: company.id,
          company,
        })),
      );
    }

    return prisma.userMapping.findMany({
      where: {
        userId,
        status: 'ACTIVE',
        companyId,
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

  private static async getAccessibleNotificationNodeScopes(
    tx: any,
    companyId: string,
    userId: string,
  ): Promise<NotificationAccessScopeNode[]> {
    const isSaasAdmin = await NotificationService.canReadAllCompanyNotifications(
      userId,
      true,
    );
    if (isSaasAdmin) {
      const nodes = await tx.orgStructure.findMany({
        where: {
          companyId,
          status: 'ACTIVE',
        },
        select: {
          id: true,
          nodeName: true,
          nodePath: true,
          nodeType: true,
        },
        orderBy: { nodePath: 'asc' },
      });

      return nodes.map((node: any) => ({
        ...node,
        levelCount: getNodeLevelCount(node.nodePath),
        modules: [...NOTIFICATION_MODULES],
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
        isGlobalAccess: true,
        roleCode: true,
        role: {
          select: {
            subCategory: true,
          },
        },
        orgStructure: {
          select: {
            id: true,
            nodeName: true,
            nodePath: true,
            nodeType: true,
          },
        },
      },
      orderBy: {
        orgStructure: { nodePath: 'asc' },
      },
    });

    const hasAdminAccess = accesses.some(
      (access: any) =>
        access.roleCode === 'SAAS_ADMIN' || access.roleCode === 'CORP_ADMIN',
    );

    if (hasAdminAccess) {
      const nodes = await tx.orgStructure.findMany({
        where: {
          companyId,
          status: 'ACTIVE',
        },
        select: {
          id: true,
          nodeName: true,
          nodePath: true,
          nodeType: true,
        },
        orderBy: { nodePath: 'asc' },
      });

      return nodes.map((node: any) => ({
        ...node,
        levelCount: getNodeLevelCount(node.nodePath),
        modules: [...NOTIFICATION_MODULES],
      }));
    }

    const globalModules = new Set<NotificationModule>();
    const uniqueNodes = new Map<
      string,
      NotificationAccessNode & { modules: Set<NotificationModule> }
    >();
    accesses.forEach((access: any) => {
      const module = NotificationService.getNotificationModuleForAccessSubCategory(
        access.role?.subCategory,
      );
      if (!module) return;

      if (access.isGlobalAccess) {
        globalModules.add(module);
      }

      const node = access.orgStructure;
      if (!node?.id) return;

      const existing = uniqueNodes.get(node.id);
      if (existing) {
        existing.modules.add(module);
        return;
      }

      uniqueNodes.set(node.id, {
        id: node.id,
        nodeName: node.nodeName,
        nodePath: node.nodePath,
        nodeType: String(node.nodeType),
        levelCount: getNodeLevelCount(node.nodePath),
        modules: new Set([module]),
      });
    });

    if (globalModules.size > 0) {
      const nodes = await tx.orgStructure.findMany({
        where: {
          companyId,
          status: 'ACTIVE',
        },
        select: {
          id: true,
          nodeName: true,
          nodePath: true,
          nodeType: true,
        },
        orderBy: { nodePath: 'asc' },
      });

      nodes.forEach((node: any) => {
        const existing = uniqueNodes.get(node.id);
        if (existing) {
          globalModules.forEach((module) => existing.modules.add(module));
          return;
        }

        uniqueNodes.set(node.id, {
          id: node.id,
          nodeName: node.nodeName,
          nodePath: node.nodePath,
          nodeType: String(node.nodeType),
          levelCount: getNodeLevelCount(node.nodePath),
          modules: new Set(globalModules),
        });
      });
    }

    return Array.from(uniqueNodes.values())
      .map((node) => ({
        id: node.id,
        nodeName: node.nodeName,
        nodePath: node.nodePath,
        nodeType: node.nodeType,
        levelCount: node.levelCount,
        modules: Array.from(node.modules).sort((left, right) =>
          left.localeCompare(right),
        ),
      }))
      .sort((left, right) => left.nodePath.localeCompare(right.nodePath));
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

    const nodeScopes =
      mapping?.status === 'ACTIVE'
        ? await NotificationService.getAccessibleNotificationNodeScopes(
            tx,
            params.companyId,
            params.userId,
          )
        : [];

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
    const existingRowsByKey = new Map<string, any>(
      existingRows.map((row: any) => [`${row.nodeId}:${row.module}`, row]),
    );

    const desiredKeys = new Set<string>();
    nodeScopes.forEach((node) => {
      node.modules.forEach((module) => {
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

      if (!existing.isEnabled) continue;

      const module =
        NotificationService.normalizeNotificationModule(existing.module) ||
        'USER';

      const newData = node
        ? NotificationService.buildNotificationSettingsHistoryPayload({
            nodePath: node.nodePath,
            nodeName: node.nodeName,
            module,
            isEnabled: false,
            remarks: null,
          })
        : null;

      await (tx as any).notificationSettingHistory.create({
        data: {
          notificationSettingId: existing.id,
          companyId: params.companyId,
          eventUserId: params.eventUserId,
          oldData,
          newData,
          remarks: params.removeReason,
        },
      });

      await (tx as any).notificationSetting.update({
        where: { id: existing.id },
        data: {
          isEnabled: false,
        },
      });
    }

    for (const node of nodeScopes) {
      for (const module of node.modules) {
        const key = `${node.id}:${module}`;
        const existing = existingRowsByKey.get(key);

        if (existing) {
          if (Boolean(existing.isEnabled)) continue;

          const oldData = NotificationService.buildNotificationSettingsHistoryPayload(
            {
              nodePath: node.nodePath,
              nodeName: node.nodeName,
              module,
              isEnabled: false,
              remarks: null,
            },
          );

          const saved = await (tx as any).notificationSetting.update({
            where: { id: existing.id },
            data: {
              isEnabled: true,
            },
          });

          await (tx as any).notificationSettingHistory.create({
            data: {
              notificationSettingId: saved.id,
              companyId: params.companyId,
              eventUserId: params.eventUserId,
              oldData,
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

          continue;
        }

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

    if (module === 'COMPANY') {
      const nodes = await tx.orgStructure.findMany({
        where: {
          companyId: input.companyId,
          status: 'ACTIVE',
          OR: [{ nodeType: 'ROOT' }, { nodePath: { not: { contains: '.' } } }],
        },
        select: { id: true },
      });

      return {
        module,
        nodeIds: NotificationService.unique(nodes.map((node: any) => node.id)),
      };
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
      requiredRecipientUserIds?: string[];
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
    const requiredRecipientUserIds = new Set(
      NotificationService.unique(params.requiredRecipientUserIds || []),
    );
    params.recipientUserIds.forEach((userId) => {
      if (requiredRecipientUserIds.has(userId)) return;
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
    const normalizedIsPending =
      input.isPending ?? NotificationService.isPendingNotificationType(input.type);
    const normalizedInput: NormalizedCreateNotificationInput = {
      ...input,
      type: normalizeNotificationTypeValue(input.type, normalizedIsPending),
      isPending: normalizedIsPending,
    };

    NotificationService.validateNotificationInput(normalizedInput);

    const [saasAdmins, createdByUser] = await Promise.all([
      NotificationService.getSaasAdminUserIds(),
      prisma.user.findUnique({
        where: { id: normalizedInput.createdBy },
        select: { name: true, email: true },
      }),
    ]);
    const actorName = NotificationService.getActorName(createdByUser || {});
    const content = NotificationService.getRequestNotificationContent(
      normalizedInput,
      actorName,
    );
    const isPending = normalizedIsPending;
    const shouldClearPreviousPending =
      Boolean(normalizedInput.referenceType) && Boolean(normalizedInput.referenceId);
    const duplicateWindowStart = new Date(Date.now() - 2 * 60 * 1000);
    const requestedRecipients = NotificationService.unique(
      [
        ...(normalizedInput.recipientUserIds || []),
        normalizedInput.includeCreatedBy === true ? normalizedInput.createdBy : null,
      ],
    );
    const [companyRecipientUserIds, requiredRecipientUserIds] =
      await Promise.all([
        NotificationService.filterActiveCompanyUserIds(
          normalizedInput.companyId,
          requestedRecipients,
        ),
        NotificationService.filterExistingUserIds(
          NotificationService.mergeRecipientUserIds(
            normalizedInput.requiredRecipientUserIds || [],
            normalizedInput.includeCreatedBy === true
              ? normalizedInput.createdBy
              : null,
          ),
        ),
      ]);
    const requiredRecipientSet = new Set(requiredRecipientUserIds);
    // SAAS admins remain global notification recipients even when they are not
    // mapped to the target company or eligible to approve its requests.
    const recipientUserIds = NotificationService.unique([
      ...companyRecipientUserIds,
      ...requiredRecipientUserIds,
      ...saasAdmins,
    ]).filter(
      (userId) =>
        normalizedInput.includeCreatedBy === true ||
        requiredRecipientSet.has(userId) ||
        userId !== normalizedInput.createdBy,
    );

    if (recipientUserIds.length === 0) return null;

    const notificationId = randomUUID();
    const now = new Date();

    const notification = await prisma.$transaction(async (tx) => {
      const hiddenRecipientUserIds =
        await NotificationService.resolveHiddenRecipientUserIds(tx, {
          companyId: normalizedInput.companyId,
          recipientUserIds,
          requiredRecipientUserIds,
          referenceType: normalizedInput.referenceType,
          referenceId: normalizedInput.referenceId,
        });
      const notificationUsers = recipientUserIds.map((userId) => ({
        id: randomUUID(),
        companyId: normalizedInput.companyId,
        userId,
        notificationId,
        status: (
          hiddenRecipientUserIds.has(userId) ? 'HIDDEN' : 'UNREAD'
        ) as NotificationVisibilityStatus,
        updatedAt: now,
      }));
      const existingNotification = await tx.notification.findFirst({
        where: {
          companyId: normalizedInput.companyId,
          type: normalizedInput.type,
          referenceType: normalizedInput.referenceType || null,
          referenceId: normalizedInput.referenceId || null,
          createdBy: normalizedInput.createdBy,
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
            companyId: normalizedInput.companyId,
            referenceType: normalizedInput.referenceType,
            referenceId: normalizedInput.referenceId,
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
          companyId: normalizedInput.companyId,
          referenceType: normalizedInput.referenceType,
          referenceId: normalizedInput.referenceId,
          now,
        });
      }

      const createdNotification = await tx.notification.create({
        data: {
          id: notificationId,
          companyId: normalizedInput.companyId,
          name: content.name,
          message: content.message,
          type: normalizedInput.type,
          referenceType: normalizedInput.referenceType || null,
          referenceId: normalizedInput.referenceId || null,
          isPending,
          createdBy: normalizedInput.createdBy,
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
          companyId: normalizedInput.companyId,
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

  private static formatFilterLabel(value: string) {
    return value
      .replace(/_/g, ' ')
      .toLowerCase()
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  private static addFilterOptionCount(
    counts: Map<string, number>,
    value?: string | null,
  ) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) return;
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }

  private static toFilterOptions(counts: Map<string, number>) {
    return Array.from(counts.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([value, count]) => ({
        label: NotificationService.formatFilterLabel(value),
        value,
        count,
      }));
  }

  private static async buildFetchFilters(params: {
    where: any;
  }): Promise<{
    status: NotificationFilterOption[];
    module: NotificationFilterOption[];
    type: NotificationFilterOption[];
  }> {
    const rows = await prisma.notificationUser.findMany({
      where: params.where,
      select: {
        status: true,
        userId: true,
        notification: {
          select: {
            companyId: true,
            type: true,
            referenceType: true,
            referenceId: true,
            isPending: true,
          },
        },
      },
    });

    const statusCounts = new Map<string, number>();
    const moduleCounts = new Map<string, number>();
    const typeCounts = new Map<string, number>();

    for (const row of rows) {
      NotificationService.addFilterOptionCount(statusCounts, row.status);
      NotificationService.addFilterOptionCount(
        moduleCounts,
        row.notification.referenceType,
      );

      const isPendingForViewer =
        await NotificationService.resolveNotificationPendingState(
          row.notification,
          row.userId,
        );
      const viewerType = getViewerNotificationTypeValue(
        row.notification.type,
        isPendingForViewer,
      );
      NotificationService.addFilterOptionCount(typeCounts, viewerType);
    }

    return {
      status: NotificationService.toFilterOptions(statusCounts),
      module: NotificationService.toFilterOptions(moduleCounts),
      type: NotificationService.toFilterOptions(typeCounts),
    };
  }

  static async fetchForUser(params: {
    userId: string;
    companyId: string;
    status?: string | string[];
    refType?: string | string[] | null;
    type?: string | string[] | null;
    dateRange?: string;
    fromDate?: string | Date;
    toDate?: string | Date;
    limit: number;
    offset: number;
    cursorId?: string | null;
    includeAllCompanies?: boolean;
  }) {
    const status = normalizeFetchStatus(params.status);
    const statusValues = normalizeFetchStatusValues(params.status);
    const referenceTypes = normalizeReferenceTypes(params.refType);
    const notificationTypes = normalizeNotificationFetchTypes(params.type);
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

    if (referenceTypes.length > 0) {
      notificationWhere.referenceType = { in: referenceTypes };
    }

    if (notificationTypes.length > 0) {
      notificationWhere.type = { in: notificationTypes };
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
      ...(statusValues
        ? { status: { in: statusValues } }
        : status === 'HIDDEN'
          ? { status: 'HIDDEN' }
          : status === 'ALL'
            ? { status: { not: 'HIDDEN' } }
            : { status }),
    };
    const unreadWhere: any = {
      ...visibleBaseWhere,
      status: 'UNREAD',
    };

    const filterWhere =
      status === 'ALL' && !statusValues ? scopedWhere : where;
    const filters = await NotificationService.buildFetchFilters({
      where: filterWhere,
    });

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
        filters,
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
    const saasAdminUserIds = await HistoryUserUtil.getSaasAdminUserIds([
      params.userId,
      ...pageRows.map((row) => row.notification?.createdBy),
    ]);

    return {
      data: await Promise.all(
        pageRows.map((row) =>
          NotificationService.formatNotification(
            row,
            undefined,
            saasAdminUserIds,
          ),
        ),
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
      filters,
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
    const saasAdminUserIds = await HistoryUserUtil.getSaasAdminUserIds([
      params.userId,
      ...rows.map((row) => row.notification?.createdBy),
    ]);

    return Promise.all(
      rows.map((row) =>
        NotificationService.formatNotification(
          row,
          undefined,
          saasAdminUserIds,
        ),
      ),
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
    const [settingsRows, scopeEntries] = await Promise.all([
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
      Promise.all(
        companyIds.map(async (companyId) => ({
          companyId,
          nodes: await NotificationService.getAccessibleNotificationNodeScopes(
            prisma,
            companyId,
            params.userId,
          ),
        })),
      ),
    ]);

    const settingsByKey = new Map<string, any>();
    settingsRows.forEach((row: any) => {
      settingsByKey.set(
        `${row.companyId}:${row.nodeId}:${row.module}`,
        row,
      );
    });
    const scopesByCompany = new Map<string, NotificationAccessScopeNode[]>();
    scopeEntries.forEach((entry) => {
      scopesByCompany.set(entry.companyId, entry.nodes);
    });

    const data = mappings.map((mapping) => {
      const companyKey = mapping.companyId;
      const visibleNodes = scopesByCompany.get(companyKey) || [];

      return {
        companyName:
          mapping.company.brandName || mapping.company.legalName || null,
        companyCode: mapping.company.companyCode,
        nodes: visibleNodes.map((node) => ({
          nodePath: node.nodePath,
          nodeName: node.nodeName,
          nodeType: node.nodeType,
          levelCount: node.levelCount,
          settings: node.modules.map((module) => {
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

        const accessibleNodeScopes =
          await NotificationService.getAccessibleNotificationNodeScopes(
            tx,
            mapping.companyId,
            params.userId,
          );
        const accessibleNodeByPath = new Map(
          accessibleNodeScopes.map((node) => [node.nodePath, node]),
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

          if (!node.modules.includes(module)) {
            throw new Error(
              `Module ${module} is not accessible for node path ${setting.nodePath} in company ${companyEntry.companyCode}`,
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
        module,
        type,
        filters,
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
        status: filters?.status || status,
        refType: filters?.module || filters?.refType || module || refType,
        type: filters?.type || type,
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
