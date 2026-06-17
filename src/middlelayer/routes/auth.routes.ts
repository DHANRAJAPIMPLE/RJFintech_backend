import { Router } from 'express';
import type { NextFunction, Response } from 'express';
import { AuthController } from '../controllers/auth/auth.controller';
import { validate } from '../middlewares/validate.middleware';
import {
  registerSchema,
  loginSchema,
  accessRightsRequestSchema,
} from '../validations/auth.validation';
import { authMiddleware } from '../middlewares/auth.middleware';
import type { AuthRequest } from '../middlewares/auth.middleware';

/**
 * Auth Routes:
 * This module manages the entry points for user authentication and session management.
 *
 * Why we use it:
 * - To handle user-facing identity operations like Login, Registration, and Logout.
 * - To implement the 'Sliding Session' mechanism via the /refresh endpoint.
 * - To provide the /me endpoint for the frontend to retrieve the current user's profile and permissions.
 */
const router = Router();

const authMiddlewareForReportee = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  if (req.body?.reportee === true) {
    return authMiddleware(req, res, next);
  }

  return next();
};

// // Logic: Public route — Create a new user account
// router.post('/register', validate(registerSchema), AuthController.register);

// Logic: Public route — Authenticate and start a session
router.post('/login', validate(loginSchema), AuthController.login);  //done

// // Logic: Semi-public — Refresh expired access tokens using the Refresh cookie
// router.post('/refresh', AuthController.refreshToken);

// Logic: Protected route — Fetches the authenticated user's profile and groups
router.post('/me', authMiddleware, AuthController.me);  //done

// Logic: Protected/Semi — End the user session
router.post('/logout', AuthController.logout);  //done

// Logic: Public/Semi — Fetch user access rights (primary/secondary) by email and companyCode
router.post(
  '/access-rights',
  validate(accessRightsRequestSchema),
  authMiddlewareForReportee,
  AuthController.getAccessRights,
);  //done

export default router;
