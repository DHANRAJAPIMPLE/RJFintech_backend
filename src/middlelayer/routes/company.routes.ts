import { Router } from 'express';
import { CompanyController } from '../controllers/company.controller';
import type { AuthRequest } from '../middlewares/auth.middleware';
import { authMiddleware } from '../middlewares/auth.middleware';

/**
 * COMPANY ROUTES LOGIC:
 * Defines endpoints for retrieving organizational data.
 * Logic:
 * 1. Protection: All routes here are wrapped with 'authMiddleware'.
 * 2. Unauthenticated users (no valid JWT) are blocked before they reach the controller.
 */
const router = Router();

// Logic: Protected route — Fetches companies specifically mapped to the session's user
router.post('/my-companies', authMiddleware, CompanyController.getMyCompanies);

// Logic: Protected route — Fetches the entire corporate hierarchy and clusters
router.post('/groups', authMiddleware, CompanyController.getGroupCompanies);

export default router;

