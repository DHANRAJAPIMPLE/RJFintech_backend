import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller';
import { validate } from '../middlewares/validate.middleware';
import { registerSchema, loginSchema } from '../validations/auth.validation';
import { authMiddleware } from '../middlewares/auth.middleware';

/**
 * AUTH ROUTES LOGIC:
 * Defines endpoints for session and account management.
 * Logic:
 * 1. Register/Login: Uses 'validate' middleware to ensure clean input.
 * 2. Refresh: Used for staying logged in without user interaction.
 * 3. Logout: Clears session data.
 */
const router = Router();

// Logic: Public route — Create a new user account
router.post('/register', validate(registerSchema), AuthController.register);

// Logic: Public route — Authenticate and start a session
router.post('/login', validate(loginSchema), AuthController.login);

// Logic: Semi-public — Refresh expired access tokens using the Refresh cookie
router.post('/refresh', AuthController.refreshToken);

// Logic: Protected route — Fetches the authenticated user's profile and groups
router.post('/me', authMiddleware, AuthController.me);

// Logic: Protected/Semi — End the user session
router.post('/logout', AuthController.logout);

export default router;

