import type { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { AppError } from '../../shared/middlewares/error.middleware';

/**
 * Validation Middleware:
 * This middleware uses the Zod library to enforce strict data schemas for incoming requests.
 * 
 * Why we use it:
 * - To ensure that only properly formatted data reaches our controllers.
 * - To provide clear, automated error messages back to the client when validation fails.
 * - To decouple validation logic from business logic in the controllers.
 * - It handles body, query, and path parameters in a single pass.
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
