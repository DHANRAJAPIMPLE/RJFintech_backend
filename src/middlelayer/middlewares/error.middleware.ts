import type { Request, Response, NextFunction } from 'express';

export class AppError extends Error {
  constructor(public message: string, public statusCode: number = 400) {
    super(message);
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/**
 * GLOBAL ERROR HANDLING LOGIC:
 * This middleare captures all errors thrown in the application (via next(error)).
 * Logic:
 * 1. Status Code: Defaults to 500 if no specific code is provided.
 * 2. Logging: Logs the error status and message to the console for server-side debugging.
 * 3. Standardization: Returns a consistent JSON object so the frontend always
 *    knows where to find the error message.
 */
export const errorMiddleware = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
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

