// need to delete this file

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
 * Global Error Handling Middleware:
 * This middleware captures all errors thrown throughout the application.
 * 
 * Why we use it:
 * - To ensure a consistent error response format for the frontend.
 * - To prevent sensitive stack traces from being exposed in production (by default).
 * - To centralize logging of server-side errors for easier debugging.
 * - It allows the use of a custom 'AppError' class to throw operational errors with status codes.
 */
export const errorMiddleware = (
  err: Error & { statusCode?: number },
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  // Logic: Server-side logging for transparency
  console.error(`[Error] ${statusCode} - ${message}`);
  if (err.stack && statusCode >= 500) console.error(err.stack);

  // Logic: Send formatted error response to client
  res.status(statusCode).json({
    status: 'error',
    statusCode,
    message,
  });
};
