import {
  createApiSpanSafely,
  findMiddlelayerMonitoringRows,
  findMonitoringRowsByTrackingId,
  toPrismaJson,
} from './monitoring.repository';

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

const formatFetchAllSpan = (row: SpanRow) => ({
  trackingId: row.trackingId,
  subCount: row.subCount,
  apiUrl: row.url,
  statusCode: row.statusCode,
  ip: row.ipAddress,
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

  static async fetchAllMiddlelayerSpans(limit: number) {
    const parents = await findMiddlelayerMonitoringRows(limit);
    return parents.map(formatFetchAllSpan);
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
