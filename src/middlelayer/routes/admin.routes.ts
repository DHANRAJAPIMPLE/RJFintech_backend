import { Router } from 'express';
import { AdminController } from '../controllers/admin.controller';
import { MonitoringController } from '../controllers/monitoring.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { adminMiddleware } from '../middlewares/admin.middleware';

/**
 * Admin Routes:
 * This module defines the API endpoints for system-level administrative actions.
 *
 * Why we use it:
 * - To provide a dedicated entry point for company management and onboarding.
 * - It strictly applies both 'authMiddleware' and 'adminMiddleware' to ensure
 *   that only authenticated SAAS_ADMINs can access these powerful endpoints.
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

// -------------monitoring routes----------------------------
router.post('/monitoring/fetch-all', MonitoringController.fetchAll);
router.post('/monitoring/details', MonitoringController.details);
// ----------------------------------------------------------

export default router;
