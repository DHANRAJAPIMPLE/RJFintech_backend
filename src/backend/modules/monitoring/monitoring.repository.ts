import { Prisma } from '@prisma/client';
import { sanitizeMonitoringPayload } from '../../../shared/utils/monitoring/sanitizeMonitoringPayload';
import { prisma } from '../../lib/prisma';

export const apiSpanDetailSelect = {
  id: true,
  trackingId: true,
  subCount: true,
  type: true,
  method: true,
  url: true,
  statusCode: true,
  latency: true,
  ipAddress: true,
  companyId: true,
  userId: true,
  createdAt: true,
  headers: true,
  reqBody: true,
  resBody: true,
  resHeaders: true,
  startedAt: true,
  endedAt: true,
} as const;

export const apiSpanMonitoringBasicSelect = {
  trackingId: true,
  subCount: true,
  type: true,
  method: true,
  url: true,
  statusCode: true,
  latency: true,
  ipAddress: true,
  createdAt: true,
  company: {
    select: {
      legalName: true,
      companyCode: true,
    },
  },
  user: {
    select: {
      name: true,
      email: true,
    },
  },
} as const;

export const apiSpanMonitoringDetailSelect = {
  trackingId: true,
  subCount: true,
  type: true,
  method: true,
  url: true,
  statusCode: true,
  latency: true,
  ipAddress: true,
  createdAt: true,
  headers: true,
  reqBody: true,
  resBody: true,
  resHeaders: true,
} as const;

export const toPrismaJson = (
  value: unknown,
): Prisma.InputJsonValue | typeof Prisma.DbNull => {
  const sanitized = sanitizeMonitoringPayload(value);

  if (sanitized === null || sanitized === undefined) {
    return Prisma.DbNull;
  }

  return sanitized as Prisma.InputJsonValue;
};

export const createApiSpanSafely = async (
  data: Prisma.ApiSpanUncheckedCreateInput,
) => {
  try {
    return await prisma.apiSpan.create({
      data,
      select: apiSpanDetailSelect,
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2003' &&
      (data.companyId || data.userId)
    ) {
      return prisma.apiSpan.create({
        data: {
          ...data,
          companyId: null,
          userId: null,
        },
        select: apiSpanDetailSelect,
      });
    }

    throw error;
  }
};

export const findMiddlelayerMonitoringRows = async (limit: number) => {
  return prisma.apiSpan.findMany({
    where: {
      type: 'MIDDLELAYER',
    },
    select: apiSpanMonitoringBasicSelect,
    orderBy: {
      createdAt: 'desc',
    },
    take: limit,
  });
};

export const findBackendMonitoringRowsByTrackingIds = async (
  trackingIds: string[],
) => {
  if (trackingIds.length === 0) return [];

  return prisma.apiSpan.findMany({
    where: {
      trackingId: {
        in: trackingIds,
      },
      type: 'BACKEND',
    },
    select: apiSpanMonitoringBasicSelect,
    orderBy: [{ trackingId: 'asc' }, { createdAt: 'asc' }],
  });
};

export const countBackendRowsByTrackingIds = async (trackingIds: string[]) => {
  if (trackingIds.length === 0) return [];

  return prisma.apiSpan.groupBy({
    by: ['trackingId'],
    where: {
      trackingId: {
        in: trackingIds,
      },
      type: 'BACKEND',
    },
    _count: {
      _all: true,
    },
  });
};

export const findMonitoringRowsByTrackingId = async (trackingId: string) => {
  return prisma.apiSpan.findMany({
    where: {
      trackingId,
    },
    select: apiSpanMonitoringDetailSelect,
    orderBy: {
      createdAt: 'asc',
    },
  });
};
