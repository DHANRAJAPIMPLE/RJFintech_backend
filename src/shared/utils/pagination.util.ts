const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

export const getPagination = (
  input: Record<string, any> = {},
  defaultLimit = DEFAULT_LIMIT,
) => {
  const rawOffset = Number(input.offset);
  const rawLimit = Number(input.limit);

  const offset =
    Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
      : defaultLimit;

  return { offset, limit };
};
