import { Buffer } from 'node:buffer';
import type { Response } from 'express';

export const calculateResponseBodySize = (body: unknown): number | null => {
  if (body === undefined || body === null) return 0;
  if (Buffer.isBuffer(body)) return body.byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (
    typeof body === 'number' ||
    typeof body === 'boolean' ||
    typeof body === 'bigint'
  ) {
    return Buffer.byteLength(String(body));
  }

  try {
    const serialized = JSON.stringify(body);
    return serialized ? Buffer.byteLength(serialized) : 0;
  } catch {
    return null;
  }
};

export const getCapturedResponseSize = (
  res: Response,
  sizeKey = 'monitoringResponseSize',
): number | null => {
  const capturedSize = res.locals[sizeKey];
  if (
    typeof capturedSize === 'number' &&
    Number.isFinite(capturedSize) &&
    capturedSize >= 0
  ) {
    return capturedSize;
  }

  const contentLength = res.getHeader('content-length');
  const rawValue = Array.isArray(contentLength)
    ? contentLength[contentLength.length - 1]
    : contentLength;
  const parsed =
    typeof rawValue === 'number' ? rawValue : Number.parseInt(`${rawValue}`, 10);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

export const captureResponseBody = (
  res: Response,
  bodyKey = 'monitoringResponseBody',
  capturedKey = 'monitoringResponseCaptured',
  sizeKey = 'monitoringResponseSize',
): void => {
  const wrappedKey = `${capturedKey}WrapperInstalled`;
  const sizeCapturedKey = `${capturedKey}SizeCaptured`;
  if (res.locals[wrappedKey]) return;

  res.locals[wrappedKey] = true;

  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  const captureSize = (body: unknown) => {
    if (res.locals[sizeCapturedKey]) return;

    const responseSize = calculateResponseBodySize(body);
    if (responseSize === null) return;

    res.locals[sizeKey] = responseSize;
    res.locals[sizeCapturedKey] = true;
  };

  res.json = ((body?: unknown) => {
    if (!res.locals[capturedKey]) {
      res.locals[bodyKey] = body ?? null;
      res.locals[capturedKey] = true;
    }
    const result = originalJson(body);
    captureSize(body);
    return result;
  }) as Response['json'];

  res.send = ((body?: unknown) => {
    if (!res.locals[capturedKey]) {
      res.locals[bodyKey] = body ?? null;
      res.locals[capturedKey] = true;
    }
    captureSize(body);
    return originalSend(body);
  }) as Response['send'];
};
