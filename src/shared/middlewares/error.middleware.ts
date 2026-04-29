import type { Request, Response, NextFunction } from 'express';

export class AppError extends Error {
  constructor(
    public message: string,
    public statusCode: number = 400,
  ) {
    super(message);
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/**
 * GLOBAL ERROR HANDLING FACTORY:
 * Creates a middleware that captures all errors thrown in the application.
 * SHARED between Middle Layer and Backend Service.
 */
export const createErrorMiddleware =
  (prefix: string = 'Error') =>
  (
    err: Error & { statusCode?: number },
    req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
    const statusCode = err.statusCode || 500;
    const message = err.message || 'Internal Server Error';

    // Logic: Server-side logging for transparency
    console.error(`[${prefix}] ${statusCode} - ${message}`);
    if (err.stack && statusCode >= 500) console.error(err.stack);

    // Logic: Send formatted error response to client
    res.status(statusCode).json({
      status: 'error',
      statusCode,
      message,
    });
  };
