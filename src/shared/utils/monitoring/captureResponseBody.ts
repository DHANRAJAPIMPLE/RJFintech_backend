import type { Response } from 'express';

export const captureResponseBody = (
  res: Response,
  bodyKey = 'monitoringResponseBody',
  capturedKey = 'monitoringResponseCaptured',
): void => {
  const wrappedKey = `${capturedKey}WrapperInstalled`;
  if (res.locals[wrappedKey]) return;

  res.locals[wrappedKey] = true;

  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  res.json = ((body?: unknown) => {
    if (!res.locals[capturedKey]) {
      res.locals[bodyKey] = body ?? null;
      res.locals[capturedKey] = true;
    }
    return originalJson(body);
  }) as Response['json'];

  res.send = ((body?: unknown) => {
    if (!res.locals[capturedKey]) {
      res.locals[bodyKey] = body ?? null;
      res.locals[capturedKey] = true;
    }
    return originalSend(body);
  }) as Response['send'];
};
