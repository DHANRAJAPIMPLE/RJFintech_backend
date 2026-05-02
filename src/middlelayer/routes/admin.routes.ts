import { Router } from 'express';
import { AdminController } from '../controllers/admin.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { adminMiddleware } from '../middlewares/admin.middleware';

/**
 * ADMIN ROUTES LOGIC:
 * Defines endpoints for system-wide administrative tasks.
 */
const router = Router();
router.use(authMiddleware);
router.use(adminMiddleware);

// -------------company routes------------------------------
router.post('/groups', AdminController.getGroupCompanies);
router.post('/initiate', AdminController.initiateCompanyOnboarding);
router.post('/action', AdminController.actionCompanyOnboarding);
router.post('/fetch-history', AdminController.fetchCompanyHistory);
// ----------------------------------------------------------

export default router;
