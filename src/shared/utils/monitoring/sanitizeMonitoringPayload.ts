const MAX_JSON_SIZE_BYTES = 50_000;
const MASKED_VALUE = '***MASKED***';

const sensitiveKeys: ReadonlySet<string> = new Set([]);

const normalizeKey = (key: string) => key.toLowerCase().replace(/[_\s-]/g, '');

const sanitizeRecursive = (value: unknown, seen: WeakSet<object>): unknown => {
  if (value === null || value === undefined) return value ?? null;

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeRecursive(item, seen));
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }

  seen.add(value);
  const sanitized: Record<string, unknown> = {};

  for (const [key, nestedValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    const normalizedKey = normalizeKey(key);

    if (normalizedKey === 'authorization') {
      sanitized.authorizationPresent =
        nestedValue !== undefined && nestedValue !== null;
      continue;
    }

    if (normalizedKey === 'cookie') {
      sanitized.cookiePresent =
        nestedValue !== undefined && nestedValue !== null;
      continue;
    }

    if (normalizedKey === 'setcookie') {
      sanitized.setCookiePresent =
        nestedValue !== undefined && nestedValue !== null;
      continue;
    }

    if (normalizedKey.includes('token')) {
      sanitized.tokenPresent =
        Boolean(sanitized.tokenPresent) ||
        (nestedValue !== undefined && nestedValue !== null);
      continue;
    }

    if (sensitiveKeys.has(normalizedKey)) {
      sanitized[key] = MASKED_VALUE;
      continue;
    }

    sanitized[key] = sanitizeRecursive(nestedValue, seen);
  }

  seen.delete(value);
  return sanitized;
};

const limitJsonSize = (value: unknown): unknown => {
  try {
    const serialized = JSON.stringify(value);
    const originalSize = serialized.length;

    if (originalSize <= MAX_JSON_SIZE_BYTES) {
      return value;
    }

    return {
      truncated: true,
      originalSize,
      preview: serialized.slice(0, MAX_JSON_SIZE_BYTES),
    };
  } catch (_error) {
    return {
      truncated: true,
      reason: 'Unable to serialize monitoring payload safely',
    };
  }
};

export const sanitizeMonitoringPayload = (value: unknown): unknown => {
  const sanitized = sanitizeRecursive(value, new WeakSet<object>());
  return limitJsonSize(sanitized);
};
