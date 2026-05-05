import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller';
import { validate } from '../middlewares/validate.middleware';
import { registerSchema, loginSchema } from '../validations/auth.validation';
import { authMiddleware } from '../middlewares/auth.middleware';

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

// // Logic: Public route — Create a new user account
// router.post('/register', validate(registerSchema), AuthController.register);

// Logic: Public route — Authenticate and start a session
router.post('/login', validate(loginSchema), AuthController.login);

// // Logic: Semi-public — Refresh expired access tokens using the Refresh cookie
// router.post('/refresh', AuthController.refreshToken);

// Logic: Protected route — Fetches the authenticated user's profile and groups
router.post('/me', authMiddleware, AuthController.me);

// Logic: Protected/Semi — End the user session
router.post('/logout', AuthController.logout);

export default router;
