import type { Request } from 'express';

type ExpressRouteLayer = {
  handle?: {
    stack?: ExpressRouteLayer[];
  };
  match?: (path: string) => boolean;
  path?: string;
  route?: {
    methods?: Record<string, boolean>;
  };
};

type ExpressRouterLike = {
  stack?: ExpressRouteLayer[];
};

const getRequestPath = (req: Request): string => {
  const rawPath = (req.originalUrl || req.path || '').split('?')[0] || '/';
  return rawPath || '/';
};

const routeSupportsMethod = (
  routeLayer: ExpressRouteLayer,
  method: string,
): boolean => {
  const methods = routeLayer.route?.methods;

  if (!methods) return false;
  if (methods[method]) return true;

  // Express treats HEAD as GET when no explicit HEAD handler exists.
  return method === 'head' && methods.get === true;
};

const trimMatchedPrefix = (path: string, matchedPrefix?: string): string => {
  if (!matchedPrefix || matchedPrefix === '/') return path || '/';
  if (!path.startsWith(matchedPrefix)) return path || '/';

  const remainingPath = path.slice(matchedPrefix.length);
  return remainingPath || '/';
};

const stackHasMatchingRoute = (
  stack: ExpressRouteLayer[] | undefined,
  path: string,
  method: string,
): boolean => {
  if (!stack?.length) return false;

  for (const layer of stack) {
    if (typeof layer.match !== 'function') continue;

    let isMatched = false;

    try {
      isMatched = layer.match(path);
    } catch {
      isMatched = false;
    }

    if (!isMatched) continue;

    if (layer.route && routeSupportsMethod(layer, method)) {
      return true;
    }

    const nestedStack = layer.handle?.stack;

    if (
      nestedStack &&
      stackHasMatchingRoute(
        nestedStack,
        trimMatchedPrefix(path, layer.path),
        method,
      )
    ) {
      return true;
    }
  }

  return false;
};

export const hasDefinedExpressRoute = (req: Request): boolean => {
  const router = (req.app as Request['app'] & {
    router?: ExpressRouterLike;
    _router?: ExpressRouterLike;
  }).router || (req.app as Request['app'] & { _router?: ExpressRouterLike })._router;

  return stackHasMatchingRoute(
    router?.stack,
    getRequestPath(req),
    req.method.toLowerCase(),
  );
};
