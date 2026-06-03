type JsonObject = Record<string, unknown>;

export type JsonPatch<T = unknown> = {
  oldData: T;
  newData: T;
};

const isPlainObject = (value: unknown): value is JsonObject => {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
};

export const cloneJson = <T>(value: T): T => {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
};

export const mergeJsonData = <T>(base: T, patch: unknown): T => {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return cloneJson((patch as T) ?? base);
  }

  const result: JsonObject = cloneJson(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = result[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      result[key] = mergeJsonData(current, value);
      continue;
    }
    result[key] = cloneJson(value);
  }

  return result as T;
};

export const buildJsonPatch = <T = unknown>(
  previous: T,
  next: T,
): JsonPatch<T> | null => {
  if (Object.is(previous, next)) {
    return null;
  }

  if (isPlainObject(previous) && isPlainObject(next)) {
    const oldData: JsonObject = {};
    const newData: JsonObject = {};
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);

    for (const key of keys) {
      const hasPrevious = Object.hasOwn(previous, key);
      const hasNext = Object.hasOwn(next, key);

      if (hasPrevious && !hasNext) {
        oldData[key] = previous[key];
        continue;
      }

      if (!hasPrevious && hasNext) {
        newData[key] = next[key];
        continue;
      }

      const childPatch = buildJsonPatch(previous[key], next[key]);
      if (childPatch) {
        oldData[key] = childPatch.oldData;
        newData[key] = childPatch.newData;
      }
    }

    if (Object.keys(oldData).length === 0 && Object.keys(newData).length === 0) {
      return null;
    }

    return {
      oldData: oldData as T,
      newData: newData as T,
    };
  }

  if (Array.isArray(previous) || Array.isArray(next)) {
    return {
      oldData: previous,
      newData: next,
    };
  }

  return {
    oldData: previous,
    newData: next,
  };
};
