import { Router } from 'express';
import { AdminController } from '../controllers/admin/admin.controller';
import { MonitoringController } from '../controllers/monitoring/monitoring.controller';
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
router.post('/groups', AdminController.getGroupCompanies);  //done
router.post('/company-details', AdminController.fetchCompanyDetails);
router.post('/initiate', AdminController.initiateCompanyOnboarding); //done
router.post('/action', AdminController.actionCompanyOnboarding);  //done
router.post('/fetch-history', AdminController.fetchCompanyHistory);  //done
// ----------------------------------------------------------

// -------------monitoring routes----------------------------
router.post('/monitoring/fetch-all', MonitoringController.fetchAll); //done
router.post('/monitoring-fetch-all', MonitoringController.fetchAll);
router.post('/monitoring/details', MonitoringController.details);  //done
// ----------------------------------------------------------

export default router;
