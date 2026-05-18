import { Prisma } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { sanitizeMonitoringPayload } from '../../../shared/utils/monitoring/sanitizeMonitoringPayload';
import { prisma } from '../../lib/prisma';

export const apiSpanTypeSchema = z.enum(['MIDDLELAYER', 'BACKEND', 'EXTERNAL']);

const optionalUuidSchema = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' ? value.trim() : value;
}, z.string().uuid().nullable());

export const monitoringApiSpanSchema = z
  .object({
    trackingId: z.string().trim().uuid(),
    subCount: z.string().trim().max(50).optional().nullable(),
    type: apiSpanTypeSchema,
    method: z
      .string()
      .trim()
      .min(1)
      .max(20)
      .transform((value) => value.toUpperCase()),
    url: z.string().trim().min(1).max(2048),
    statusCode: z.number().int().min(100).max(599).optional().nullable(),
    headers: z.unknown().optional().nullable(),
    reqBody: z.unknown().optional().nullable(),
    resBody: z.unknown().optional().nullable(),
    resHeaders: z.unknown().optional().nullable(),
    latency: z.number().int().min(0).optional().nullable(),
    ipAddress: z.string().trim().max(128).optional().nullable(),
    companyId: optionalUuidSchema.optional(),
    userId: optionalUuidSchema.optional(),
    startedAt: z.coerce.date().optional(),
    endedAt: z.coerce.date().optional().nullable(),
  })
  .strict();

type ApiSpanTypeValue = 'MIDDLELAYER' | 'BACKEND' | 'EXTERNAL';

type CreateApiSpanInput = {
  trackingId: string;
  subCount?: string | null;
  type: ApiSpanTypeValue;
  method: string;
  url: string;
  statusCode?: number | null;
  headers?: unknown;
  reqBody?: unknown;
  resBody?: unknown;
  resHeaders?: unknown;
  latency?: number | null;
  ipAddress?: string | null;
  companyId?: string | null;
  userId?: string | null;
  startedAt?: Date;
  endedAt?: Date | null;
};

type SpanRow = any;

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

export const findMiddlelayerMonitoringRows = async (
  limit: number,
  offset: number,
) => {
  return prisma.apiSpan.findMany({
    where: {
      type: 'MIDDLELAYER',
    },
    select: apiSpanMonitoringBasicSelect,
    orderBy: {
      createdAt: 'desc',
    },
    skip: offset,
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

const getSubCountNumber = (subCount?: string | null): number | null => {
  const match = /^b(\d+)$/i.exec(subCount ?? '');
  return match?.[1] ? Number(match[1]) : null;
};

const sortBySubCount = (left: SpanRow, right: SpanRow) => {
  const leftNumber = getSubCountNumber(left.subCount);
  const rightNumber = getSubCountNumber(right.subCount);

  if (leftNumber !== null && rightNumber !== null) {
    return leftNumber - rightNumber;
  }

  if (leftNumber !== null) return -1;
  if (rightNumber !== null) return 1;

  return left.createdAt.getTime() - right.createdAt.getTime();
};

const formatFetchAllSpan = (row: SpanRow, spanCount: number) => ({
  trackingId: row.trackingId,
  subCount: row.subCount,
  apiUrl: row.url,
  statusCode: row.statusCode,
  ip: row.ipAddress,
  spanCount,
  companyName: row.company?.legalName ?? null,
  companyCode: row.company?.companyCode ?? null,
  userName: row.user?.name ?? null,
  userEmail: row.user?.email ?? null,
  createdAt: row.createdAt,
});

const formatDetailParentSpan = (row: SpanRow) => ({
  trackingId: row.trackingId,
  subCount: row.subCount,
  type: row.type,
  method: row.method,
  apiUrl: row.url,
  statusCode: row.statusCode,
  ip: row.ipAddress,
  createdAt: row.createdAt,
  latency: row.latency,
  req: {
    header: row.headers,
    body: row.reqBody,
  },
  res: {
    header: row.resHeaders,
    body: row.resBody,
  },
});

const formatDetailChildSpan = (row: SpanRow) => ({
  subCount: row.subCount,
  method: row.method,
  apiUrl: row.url,
  statusCode: row.statusCode,
  ip: row.ipAddress,
  createdAt: row.createdAt,
  latency: row.latency,
  req: {
    header: row.headers,
    body: row.reqBody,
  },
  res: {
    header: row.resHeaders,
    body: row.resBody,
  },
});

export class MonitoringService {
  static async createApiSpan(payload: CreateApiSpanInput) {
    return createApiSpanSafely({
      trackingId: payload.trackingId,
      subCount: payload.subCount ?? null,
      type: payload.type,
      method: payload.method,
      url: payload.url,
      statusCode: payload.statusCode ?? null,
      headers: toPrismaJson(payload.headers ?? null),
      reqBody: toPrismaJson(payload.reqBody ?? null),
      resBody: toPrismaJson(payload.resBody ?? null),
      resHeaders: toPrismaJson(payload.resHeaders ?? null),
      latency: payload.latency ?? null,
      ipAddress: payload.ipAddress ?? null,
      companyId: payload.companyId ?? null,
      userId: payload.userId ?? null,
      startedAt: payload.startedAt ?? new Date(),
      endedAt: payload.endedAt ?? null,
    });
  }

  static async fetchAllMiddlelayerSpans(limit: number, offset: number) {
    const parents = await findMiddlelayerMonitoringRows(limit, offset);
    const trackingIds = parents.map((parent) => parent.trackingId);
    const counts = await countBackendRowsByTrackingIds(trackingIds);
    const countByTrackingId = new Map(
      counts.map((count) => [count.trackingId, count._count._all]),
    );

    return parents.map((parent) =>
      formatFetchAllSpan(parent, countByTrackingId.get(parent.trackingId) ?? 0),
    );
  }

  static async getTraceDetails(trackingId: string) {
    const rows = await findMonitoringRowsByTrackingId(trackingId);

    if (rows.length === 0) {
      return null;
    }

    const parent =
      rows.find((row) => row.type === 'MIDDLELAYER' && row.subCount === 'm1') ??
      rows.find((row) => row.type === 'MIDDLELAYER') ??
      null;
    const childRows = rows
      .filter((row) => row.type === 'BACKEND')
      .sort(sortBySubCount);

    return {
      parent: parent ? formatDetailParentSpan(parent) : null,
      child: childRows.map(formatDetailChildSpan),
    };
  }
}

const formatZodIssues = (issues: z.ZodIssue[]) => {
  return issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
};

const getOptionalLimit = (value: unknown): number => {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return 100;
  }

  return Math.min(Math.max(Math.trunc(parsed), 1), 500);
};

const getOptionalOffset = (value: unknown): number => {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.max(Math.trunc(parsed), 0);
};

const getTrackingId = (req: Request): string | null => {
  const value =
    req.body?.trackingId ||
    req.body?.trackId ||
    req.body?.tracking_id ||
    req.get('x-tracking-id');

  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

export class MonitoringController {
  static async createMiddlelayerApiSpan(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const parsed = monitoringApiSpanSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Invalid monitoring api span payload',
          details: formatZodIssues(parsed.error.issues),
        });
      }

      const apiSpan = await MonitoringService.createApiSpan(parsed.data);
      return res.status(201).json(apiSpan);
    } catch (error) {
      return next(error);
    }
  }

  static async fetchAll(req: Request, res: Response, next: NextFunction) {
    try {
      const spans = await MonitoringService.fetchAllMiddlelayerSpans(
        getOptionalLimit(req.body?.limit ?? req.query?.limit),
        getOptionalOffset(req.body?.offset ?? req.query?.offset),
      );
      return res.status(200).json(spans);
    } catch (error) {
      return next(error);
    }
  }

  static async details(req: Request, res: Response, next: NextFunction) {
    try {
      const trackingId = getTrackingId(req);

      if (!trackingId) {
        return res.status(400).json({ error: 'trackingId is required' });
      }

      const trace = await MonitoringService.getTraceDetails(trackingId);

      if (!trace) {
        return res.status(404).json({ error: 'Monitoring trace not found' });
      }

      return res.status(200).json(trace);
    } catch (error) {
      return next(error);
    }
  }
}

export { MonitoringController as MonitoringDbController };
