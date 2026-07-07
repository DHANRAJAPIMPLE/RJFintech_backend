import { AppError } from '../middlewares/error.middleware';
import { getPagination } from './pagination.util';

export type PageDirection = 'next' | 'prev';

export type CreatedAtCursor = {
  id: string;
  createdAt: Date;
};

export type CursorRow = {
  id: string;
  createdAt: Date;
};

export const normalizePageDirection = (value: unknown): PageDirection =>
  typeof value === 'string' &&
  ['prev', 'previous'].includes(value.trim().toLowerCase())
    ? 'prev'
    : 'next';

export const encodeCursor = (row?: CursorRow | null) => {
  if (!row) return null;

  return Buffer.from(
    JSON.stringify({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
    }),
  ).toString('base64url');
};

export const decodeCursor = (value: unknown): CreatedAtCursor | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;

  const normalizedValue = value.trim();
  if (
    !normalizedValue ||
    ['null', 'undefined'].includes(normalizedValue.toLowerCase())
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(normalizedValue, 'base64url').toString('utf8'),
    );
    const createdAt = new Date(payload.createdAt);
    if (
      typeof payload.id !== 'string' ||
      !payload.id ||
      Number.isNaN(createdAt.getTime())
    ) {
      throw new Error('Invalid cursor payload');
    }

    return { id: payload.id, createdAt };
  } catch {
    throw new AppError('Invalid pagination cursor', 400);
  }
};

export const appendCursorWhere = (
  where: Record<string, unknown>,
  cursor: CreatedAtCursor | null,
  direction: 'older' | 'newer',
) => {
  if (!cursor) return where;

  const operator = direction === 'older' ? 'lt' : 'gt';
  return {
    AND: [
      where,
      {
        OR: [
          { createdAt: { [operator]: cursor.createdAt } },
          {
            createdAt: cursor.createdAt,
            id: { [operator]: cursor.id },
          },
        ],
      },
    ],
  };
};

export const getPageOrder = (direction: PageDirection) =>
  direction === 'prev'
    ? ([{ createdAt: 'asc' }, { id: 'asc' }] as const)
    : ([{ createdAt: 'desc' }, { id: 'desc' }] as const);

export const isRowInCursorDirection = (
  row: CursorRow,
  cursor: CreatedAtCursor,
  direction: 'older' | 'newer',
) => {
  const rowTime = row.createdAt.getTime();
  const cursorTime = cursor.createdAt.getTime();

  return direction === 'older'
    ? rowTime < cursorTime || (rowTime === cursorTime && row.id < cursor.id)
    : rowTime > cursorTime || (rowTime === cursorTime && row.id > cursor.id);
};

export const resolveCursorPagination = (
  input: Record<string, unknown> = {},
) => {
  const pagination = getPagination(input);
  const rawPage = Number(input.page);
  const requestedPage =
    input.page !== null &&
    input.page !== undefined &&
    Number.isFinite(rawPage) &&
    rawPage > 0
      ? Math.floor(rawPage)
      : null;
  const direction = normalizePageDirection(input.direction);
  const rawCursor =
    input.cursor ??
    (direction === 'prev' ? input.prevCursor : input.nextCursor) ??
    input.cursorId ??
    null;
  const cursor = decodeCursor(rawCursor);
  const isPagePagination = requestedPage !== null && !cursor;
  const limit = pagination.limit;
  const offset = isPagePagination
    ? (requestedPage - 1) * limit
    : pagination.offset;
  const page = requestedPage ?? Math.floor(offset / limit) + 1;

  return {
    cursor: isPagePagination ? null : cursor,
    topCursor: isPagePagination ? null : decodeCursor(input.topCursor),
    requestedTopCursor:
      isPagePagination || typeof input.topCursor !== 'string'
        ? null
        : input.topCursor,
    direction: cursor ? direction : ('next' as const),
    limit,
    offset,
    page,
    isPagePagination,
  };
};

export const buildPage = <T extends CursorRow>(
  rows: T[],
  params: ReturnType<typeof resolveCursorPagination>,
  newCount: number,
) => {
  const hasExtra = rows.length > params.limit;
  const limitedRows = hasExtra ? rows.slice(0, params.limit) : rows;
  const pageRows =
    params.direction === 'prev' ? [...limitedRows].reverse() : limitedRows;
  const firstRow = pageRows[0] || null;
  const lastRow = pageRows[pageRows.length - 1] || null;
  const hasNext = params.direction === 'prev' ? !!params.cursor : hasExtra;
  const hasPrev = params.isPagePagination
    ? params.page > 1
    : params.direction === 'prev'
      ? hasExtra
      : !!params.cursor;

  return {
    pageRows,
    pageInfo: {
      page: params.page,
      nextCursor: hasNext ? encodeCursor(lastRow) : null,
      prevCursor: hasPrev ? encodeCursor(firstRow) : null,
      topCursor: params.requestedTopCursor || encodeCursor(firstRow),
      hasNext,
      hasPrev,
      hasNewData: newCount > 0,
      newCount,
    },
  };
};

export const getInMemoryPageRows = <T extends CursorRow>(
  rows: T[],
  params: ReturnType<typeof resolveCursorPagination>,
) => {
  const directionMultiplier = params.direction === 'prev' ? 1 : -1;
  const orderedRows = [...rows].sort((left, right) => {
    const createdAtComparison =
      left.createdAt.getTime() - right.createdAt.getTime();
    if (createdAtComparison !== 0) {
      return createdAtComparison * directionMultiplier;
    }

    return left.id.localeCompare(right.id) * directionMultiplier;
  });
  const cursorRows = params.cursor
    ? orderedRows.filter((row) =>
        isRowInCursorDirection(
          row,
          params.cursor as CreatedAtCursor,
          params.direction === 'prev' ? 'newer' : 'older',
        ),
      )
    : orderedRows;
  const start = params.cursor ? 0 : params.offset;

  return cursorRows.slice(start, start + params.limit + 1);
};
