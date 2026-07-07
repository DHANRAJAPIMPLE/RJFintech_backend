const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const asNonEmptyString = (value: unknown): string | null => {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

export const asUuid = (value: unknown): string | null => {
  const stringValue = asNonEmptyString(value);
  return stringValue && uuidRegex.test(stringValue) ? stringValue : null;
};
