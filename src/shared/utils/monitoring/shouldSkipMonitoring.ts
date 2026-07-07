import type { Request } from 'express';

const ignoredPaths = ['/monitoring', '/health', '/metrics', '/favicon.ico','/api/v1/admin', '/admin'];


const getPathname = (rawPath: string): string => {
  const withoutQuery = rawPath.split('?')[0] || '/';

  try {
    return new URL(withoutQuery).pathname || '/';
  } catch {
    return withoutQuery;
  }
};

export const shouldSkipMonitoringPath = (
  rawPath: string,
  method?: string,
): boolean => {
  if (method?.toUpperCase() === 'OPTIONS') return true;

  const path = getPathname(rawPath);

  if (path === '/') return true;
  if (path.includes('/monitoring/')) return true;


  return ignoredPaths.some(
    (ignoredPath) => path === ignoredPath || path.startsWith(`${ignoredPath}/`),
  );
};

export const shouldSkipMonitoring = (req: Request): boolean => {
  const path = (req.originalUrl || req.path || '').split('?')[0] || '';
  return shouldSkipMonitoringPath(path, req.method);
};
