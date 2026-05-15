import { Router } from 'express';
import { MonitoringDbController } from '../modules/monitoring/monitoring.db.modules';

const router = Router();

/**
 * Internal Monitoring Routes:
 * Used by the Middle Layer to fetch observability data for SAAS Admins.
 */
router.post('/fetch-all', MonitoringDbController.fetchTraces);
router.post('/details', MonitoringDbController.getTraceDetails);

export default router;
