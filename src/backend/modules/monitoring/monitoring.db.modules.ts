import { Prisma } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { sanitizeMonitoringPayload } from '../../../shared/utils/monitoring/sanitizeMonitoringPayload';
import { prisma } from '../../lib/prisma';
import {
  appendCursorWhere,
  buildPage,
  decodeCursor,
  getPageOrder,
  resolveCursorPagination,
} from '../../../shared/utils/cursor-pagination.util';

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
    responseSize: z.number().int().min(0).optional().nullable(),
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
type ResponseSizeSort = 'asc' | 'desc';
type MonitoringCursor = {
  id: string;
  createdAt: Date;
  responseSize?: number | null;
};

type MonitoringFilters = {
  query: string | null;
  dateRange: '7DAYS' | '15DAYS' | '1MONTH' | 'CUSTOM' | null;
  fromDate: string | null;
  toDate: string | null;
  status: number[];
  responseSizeSort: ResponseSizeSort | null;
  responseSizeRange: {
    min?: number;
    max?: number;
  } | null;
  subTrack: number[];
};

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
  responseSize?: number | null;
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
  responseSize: true,
  resHeaders: true,
  startedAt: true,
  endedAt: true,
} as const;

export const apiSpanMonitoringBasicSelect = {
  id: true,
  trackingId: true,
  subCount: true,
  type: true,
  method: true,
  url: true,
  statusCode: true,
  responseSize: true,
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
  responseSize: true,
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
  where: Record<string, unknown>,
  pagination: ReturnType<typeof resolveCursorPagination>,
  responseSizeSort?: ResponseSizeSort | null,
) => {
  return prisma.apiSpan.findMany({
    where: where as any,
    select: apiSpanMonitoringBasicSelect,
    orderBy: getMonitoringPageOrder(
      pagination.direction,
      responseSizeSort,
    ) as any,
    skip: pagination.cursor ? 0 : pagination.offset,
    take: pagination.limit + 1,
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
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Prisma aggregate API key.
    _count: {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- Prisma aggregate API key.
      _all: true,
    },
  });
};

const getMonitoringPageOrder = (
  direction: 'next' | 'prev',
  responseSizeSort?: ResponseSizeSort | null,
) => {
  if (!responseSizeSort) return getPageOrder(direction);

  const sortDirection =
    direction === 'prev'
      ? responseSizeSort === 'asc'
        ? 'desc'
        : 'asc'
      : responseSizeSort;

  return [
    { responseSize: sortDirection },
    { createdAt: direction === 'prev' ? 'asc' : 'desc' },
    { id: direction === 'prev' ? 'asc' : 'desc' },
  ] as const;
};

const getMonitoringRawCursor = (
  input: Record<string, unknown>,
  pagination: ReturnType<typeof resolveCursorPagination>,
) =>
  input.cursor ??
  (pagination.direction === 'prev' ? input.prevCursor : input.nextCursor) ??
  input.cursorId ??
  null;

const decodeMonitoringCursor = (value: unknown): MonitoringCursor | null => {
  const baseCursor = decodeCursor(value);
  if (!baseCursor || typeof value !== 'string') return baseCursor;

  try {
    const payload = JSON.parse(
      Buffer.from(value.trim(), 'base64url').toString('utf8'),
    );
    const responseSize = Number(payload.responseSize);

    return {
      ...baseCursor,
      responseSize: Number.isInteger(responseSize) ? responseSize : null,
    };
  } catch {
    return baseCursor;
  }
};

const encodeMonitoringCursor = (row?: SpanRow | null) => {
  if (!row) return null;

  return Buffer.from(
    JSON.stringify({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      responseSize: row.responseSize ?? null,
    }),
  ).toString('base64url');
};

const appendResponseSizeCursorWhere = (
  where: Record<string, unknown>,
  cursor: MonitoringCursor | null,
  direction: 'next' | 'prev',
  responseSizeSort?: ResponseSizeSort | null,
) => {
  if (
    !cursor ||
    !responseSizeSort ||
    cursor.responseSize === null ||
    cursor.responseSize === undefined
  ) {
    return appendCursorWhere(
      where,
      cursor,
      direction === 'prev' ? 'newer' : 'older',
    );
  }

  const responseSizeOperator =
    direction === 'next'
      ? responseSizeSort === 'asc'
        ? 'gt'
        : 'lt'
      : responseSizeSort === 'asc'
        ? 'lt'
        : 'gt';
  const createdAtOperator = direction === 'next' ? 'lt' : 'gt';
  const idOperator = direction === 'next' ? 'lt' : 'gt';

  return {
    AND: [
      where,
      {
        OR: [
          { responseSize: { [responseSizeOperator]: cursor.responseSize } },
          {
            responseSize: cursor.responseSize,
            createdAt: { [createdAtOperator]: cursor.createdAt },
          },
          {
            responseSize: cursor.responseSize,
            createdAt: cursor.createdAt,
            id: { [idOperator]: cursor.id },
          },
        ],
      },
    ],
  };
};

const buildMonitoringPage = (
  rows: SpanRow[],
  pagination: ReturnType<typeof resolveCursorPagination>,
  newCount: number,
  responseSizeSort?: ResponseSizeSort | null,
) => {
  if (!responseSizeSort) return buildPage(rows, pagination, newCount);

  const hasExtra = rows.length > pagination.limit;
  const limitedRows = hasExtra ? rows.slice(0, pagination.limit) : rows;
  const pageRows =
    pagination.direction === 'prev' ? [...limitedRows].reverse() : limitedRows;
  const firstRow = pageRows[0] || null;
  const lastRow = pageRows[pageRows.length - 1] || null;
  const hasNext =
    pagination.direction === 'prev' ? !!pagination.cursor : hasExtra;
  const hasPrev = pagination.isPagePagination
    ? pagination.page > 1
    : pagination.direction === 'prev'
      ? hasExtra
      : !!pagination.cursor;

  return {
    pageRows,
    pageInfo: {
      page: pagination.page,
      nextCursor: hasNext ? encodeMonitoringCursor(lastRow) : null,
      prevCursor: hasPrev ? encodeMonitoringCursor(firstRow) : null,
      topCursor:
        pagination.requestedTopCursor || encodeMonitoringCursor(firstRow),
      hasNext,
      hasPrev,
      hasNewData: newCount > 0,
      newCount,
    },
  };
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

const formatResponseSize = (bytes?: number | null): string | null => {
  if (bytes === null || bytes === undefined) return null;
  if (!Number.isFinite(bytes) || bytes < 0) return null;

  const units = ['Byte', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  if (unitIndex === 0) {
    return `${bytes} ${bytes === 1 ? 'Byte' : 'Bytes'}`;
  }

  const formatted = value.toFixed(2).replace(/\.?0+$/, '');
  return `${formatted} ${units[unitIndex]}`;
};

const formatFetchAllSpan = (row: SpanRow, spanCount: number) => ({
  trackingId: row.trackingId,
  subCount: row.subCount,
  apiUrl: row.url,
  statusCode: row.statusCode,
  responseSize: formatResponseSize(row.responseSize),
  ip: row.ipAddress,
  spanCount,
  companyName: row.company?.legalName ?? null,
  companyCode: row.company?.companyCode ?? null,
  userName: row.user?.name ?? null,
  userEmail: row.user?.email ?? null,
  createdAt: row.createdAt,
});

const normalizeString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  return trimmed && !['null', 'undefined'].includes(trimmed.toLowerCase())
    ? trimmed
    : null;
};

const normalizeNumberArray = (value: unknown): number[] => {
  const source =
    typeof value === 'string' && value.includes(',')
      ? value.split(',')
      : Array.isArray(value)
        ? value
        : value === undefined || value === null || value === ''
          ? []
          : [value];

  return Array.from(
    new Set(
      source
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && item >= 0),
    ),
  );
};

const normalizeDateRange = (value: unknown): MonitoringFilters['dateRange'] => {
  let normalized = normalizeString(value)
    ?.toUpperCase()
    .replace(/[\s-]+/g, '');

  if (normalized === '7DAY') normalized = '7DAYS';
  if (normalized === '15DAY') normalized = '15DAYS';

  return normalized &&
    ['7DAYS', '15DAYS', '1MONTH', 'CUSTOM'].includes(normalized)
    ? (normalized as MonitoringFilters['dateRange'])
    : null;
};

const normalizeResponseSizeSort = (value: unknown): ResponseSizeSort | null => {
  const normalized = normalizeString(value)?.toLowerCase();
  return normalized === 'asc' || normalized === 'desc' ? normalized : null;
};

const normalizeResponseSizeRange = (
  value: unknown,
): MonitoringFilters['responseSizeRange'] => {
  if (typeof value === 'string') {
    const match = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(value);
    if (!match) return null;

    const min = Number(match[1]);
    const max = Number(match[2]);
    return min <= max ? { min, max } : { min: max, max: min };
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const range = value as Record<string, unknown>;
  const min = Number(range.min);
  const max = Number(range.max);
  const normalizedRange: { min?: number; max?: number } = {};

  if (Number.isInteger(min) && min >= 0) normalizedRange.min = min;
  if (Number.isInteger(max) && max >= 0) normalizedRange.max = max;

  if (
    normalizedRange.min !== undefined &&
    normalizedRange.max !== undefined &&
    normalizedRange.min > normalizedRange.max
  ) {
    return {
      min: normalizedRange.max,
      max: normalizedRange.min,
    };
  }

  return Object.keys(normalizedRange).length > 0 ? normalizedRange : null;
};

const getAppliedMonitoringFilterInput = (
  input: Record<string, unknown>,
): Record<string, unknown> => {
  if (
    input.applied &&
    typeof input.applied === 'object' &&
    !Array.isArray(input.applied)
  ) {
    return input.applied as Record<string, unknown>;
  }

  if (input.filter === true) {
    return {};
  }

  return input.filter === false ? {} : input;
};

const resolveMonitoringFilters = (
  input: Record<string, unknown>,
): MonitoringFilters => {
  const applied = getAppliedMonitoringFilterInput(input);
  const responseSizeSort = normalizeResponseSizeSort(
    applied.responseSizeSort ?? applied.responseSize,
  );
  const responseSizeRange = normalizeResponseSizeRange(
    applied.responseSizeRange ??
      (responseSizeSort ? null : applied.responseSize),
  );

  return {
    query: normalizeString(applied.query ?? input.query),
    dateRange: normalizeDateRange(
      applied.dateRange ?? applied.date ?? applied.data,
    ),
    fromDate: normalizeString(applied.fromDate ?? applied.formDate),
    toDate: normalizeString(applied.toDate),
    status: normalizeNumberArray(applied.status).filter(
      (status) => status >= 100 && status <= 599,
    ),
    responseSizeSort,
    responseSizeRange,
    subTrack: normalizeNumberArray(applied.subTrack ?? applied.subtrack),
  };
};

const getDateBoundary = (
  value: string | null,
  boundary: 'start' | 'end',
): Date | null => {
  if (!value) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  if (boundary === 'start') {
    return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
  }

  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      23,
      59,
      59,
      999,
    ),
  );
};

const resolveCreatedAtFilter = (filters: MonitoringFilters) => {
  const explicitFrom = getDateBoundary(filters.fromDate, 'start');
  const explicitTo = getDateBoundary(filters.toDate, 'end');

  if (filters.dateRange === 'CUSTOM') {
    return explicitFrom && explicitTo
      ? { gte: explicitFrom, lte: explicitTo }
      : null;
  }

  if (explicitFrom || explicitTo) {
    return {
      ...(explicitFrom ? { gte: explicitFrom } : {}),
      ...(explicitTo ? { lte: explicitTo } : {}),
    };
  }

  const now = new Date();
  const daysByRange: Record<string, number> = {
    '7DAYS': 7,
    '15DAYS': 15,
    '1MONTH': 30,
  };
  const days = filters.dateRange ? daysByRange[filters.dateRange] : null;

  if (!days) return null;

  return {
    gte: new Date(now.getTime() - days * 24 * 60 * 60 * 1000),
    lte: now,
  };
};

const resolveStatusFilter = (statuses: number[]) => {
  const statusFilters = statuses.map((status) =>
    status % 100 === 0
      ? { statusCode: { gte: status, lt: Math.min(status + 100, 600) } }
      : { statusCode: status },
  );

  if (statusFilters.length === 0) return {};
  if (statusFilters.length === 1) return statusFilters[0];
  return { OR: statusFilters };
};

const resolveResponseSizeRangeFilter = (
  range: MonitoringFilters['responseSizeRange'],
) => {
  if (!range) return {};

  return {
    responseSize: {
      ...(range.min !== undefined ? { gte: range.min } : {}),
      ...(range.max !== undefined ? { lte: range.max } : {}),
    },
  };
};

const resolveSubTrackTrackingIds = async (
  subTrack: number[],
): Promise<string[] | null> => {
  if (subTrack.length === 0) return null;

  const backendCounts = await prisma.apiSpan.groupBy({
    by: ['trackingId'],
    where: {
      type: 'BACKEND',
    },
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Prisma aggregate API key.
    _count: {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- Prisma aggregate API key.
      _all: true,
    },
  });

  const allowedCounts = new Set(subTrack);
  return backendCounts
    .filter((count) => allowedCounts.has(count._count._all))
    .map((count) => count.trackingId);
};

const formatDetailParentSpan = (row: SpanRow) => ({
  trackingId: row.trackingId,
  subCount: row.subCount,
  type: row.type,
  method: row.method,
  apiUrl: row.url,
  statusCode: row.statusCode,
  responseSize: formatResponseSize(row.responseSize),
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
  responseSize: formatResponseSize(row.responseSize),
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
      responseSize: payload.responseSize ?? null,
      resHeaders: toPrismaJson(payload.resHeaders ?? null),
      latency: payload.latency ?? null,
      ipAddress: payload.ipAddress ?? null,
      companyId: payload.companyId ?? null,
      userId: payload.userId ?? null,
      startedAt: payload.startedAt ?? new Date(),
      endedAt: payload.endedAt ?? null,
    });
  }

  static async fetchAllMiddlelayerSpans(input: Record<string, unknown>) {
    const filters = resolveMonitoringFilters(input);
    const query = filters.query;
    const pagination = resolveCursorPagination(input);
    const monitoringCursor = decodeMonitoringCursor(
      getMonitoringRawCursor(input, pagination),
    );
    const monitoringTopCursor = decodeMonitoringCursor(input.topCursor);

    const queryFilter: any = query
      ? {
          OR: [
            { url: { contains: query, mode: 'insensitive' as const } },
            { ipAddress: { contains: query, mode: 'insensitive' as const } },
            { trackingId: { contains: query, mode: 'insensitive' as const } },
            {
              company: {
                is: {
                  legalName: { contains: query, mode: 'insensitive' as const },
                },
              },
            },
            {
              company: {
                is: {
                  companyCode: {
                    contains: query,
                    mode: 'insensitive' as const,
                  },
                },
              },
            },
            {
              user: {
                is: {
                  name: { contains: query, mode: 'insensitive' as const },
                },
              },
            },
            {
              user: {
                is: {
                  email: { contains: query, mode: 'insensitive' as const },
                },
              },
            },
          ],
        }
      : {};
    const createdAtFilter = resolveCreatedAtFilter(filters);
    const statusFilter = resolveStatusFilter(filters.status);
    const responseSizeRangeFilter = resolveResponseSizeRangeFilter(
      filters.responseSizeRange,
    );
    const subTrackTrackingIds = await resolveSubTrackTrackingIds(
      filters.subTrack,
    );

    const filterParts = [
      queryFilter,
      statusFilter,
      responseSizeRangeFilter,
      createdAtFilter ? { createdAt: createdAtFilter } : {},
      subTrackTrackingIds
        ? {
            trackingId: {
              in: subTrackTrackingIds,
            },
          }
        : {},
    ].filter((filter) => Object.keys(filter).length > 0);

    const where: any = {
      type: 'MIDDLELAYER',
      ...(filterParts.length > 0 ? { AND: filterParts } : {}),
    };

    const pageWhere = pagination.cursor
      ? appendResponseSizeCursorWhere(
          where,
          monitoringCursor,
          pagination.direction,
          filters.responseSizeSort,
        )
      : where;
    const newWhere = pagination.topCursor
      ? appendResponseSizeCursorWhere(
          where,
          monitoringTopCursor,
          'prev',
          filters.responseSizeSort,
        )
      : null;
    const [totalCount, parentRows, newCount] = await Promise.all([
      prisma.apiSpan.count({ where }),
      findMiddlelayerMonitoringRows(
        pageWhere,
        pagination,
        filters.responseSizeSort,
      ),
      newWhere
        ? prisma.apiSpan.count({ where: newWhere as any })
        : Promise.resolve(0),
    ]);
    const pageData = buildMonitoringPage(
      parentRows,
      pagination,
      newCount,
      filters.responseSizeSort,
    );
    const firstPageRow = pageData.pageRows[0];
    if (pagination.cursor && !pagination.isPagePagination && firstPageRow) {
      const newerCount = await prisma.apiSpan.count({
        where: appendResponseSizeCursorWhere(
          where,
          firstPageRow,
          'prev',
          filters.responseSizeSort,
        ) as any,
      });
      pageData.pageInfo.page = Math.floor(newerCount / pagination.limit) + 1;
    }
    const trackingIds = pageData.pageRows.map((parent) => parent.trackingId);
    const counts = await countBackendRowsByTrackingIds(trackingIds);
    const countByTrackingId = new Map(
      counts.map((count) => [count.trackingId, count._count._all]),
    );

    return {
      data: pageData.pageRows.map((parent) =>
        formatFetchAllSpan(
          parent,
          countByTrackingId.get(parent.trackingId) ?? 0,
        ),
      ),
      totalCount,
      pageInfo: pageData.pageInfo,
    };
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
        req.body ?? {},
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
