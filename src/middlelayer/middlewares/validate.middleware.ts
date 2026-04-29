import type { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { AppError } from '../../shared/middlewares/error.middleware';

/**
 * VALIDATION MIDDLEWARE LOGIC:
 * Higher-order function that returns a middleware for validating request data.
 * Logic:
 * 1. Schema Parsing: Uses Zod to check body, query, and params against a schema.
 * 2. Async Support: Supports asynchronous validation rules.
 * 3. Error Handling: Catches ZodErrors, maps them to user-friendly messages,
 *    and forwards them to the global error handler.
 */
export const validate = (schema: z.ZodTypeAny) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Logic: Validate the full request object.
      // parseAsync validates and returns the data, or throws if data is invalid.
      await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      next(); // Logic: Validation passed, proceed to next middleware/controller
    } catch (error) {
      // Logic: Specifically capture validation-related errors from Zod
      if (error instanceof ZodError) {
        // Logic: Convert complex Zod error issues into a single readable string
        const message = error.issues
          .map(
            (issue: z.ZodIssue) => `${issue.path.join('.')}: ${issue.message}`,
          )
          .join(', ');
        return next(new AppError(message, 400));
      }
      next(error); // Logic: Pass non-validation errors (500s) to global handler
    }
  };
};
