import type { Request } from 'express';

const ignoredPaths = ['/monitoring', '/health', '/metrics', '/favicon.ico'];

export const shouldSkipMonitoring = (req: Request): boolean => {
  if (req.method === 'OPTIONS') return true;
  const path = (req.originalUrl || req.path || '').split('?')[0] || '';

  if (path.includes('/monitoring/')) return true;

  return ignoredPaths.some(
    (ignoredPath) => path === ignoredPath || path.startsWith(`${ignoredPath}/`),
  );
};
