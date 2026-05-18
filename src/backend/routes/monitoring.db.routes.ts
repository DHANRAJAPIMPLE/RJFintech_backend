import { Router } from 'express';
import { MonitoringController } from '../modules/monitoring/monitoring.db.modules';

const router = Router();

router.post('/api-span', MonitoringController.createMiddlelayerApiSpan);
router.post('/fetch-all', MonitoringController.fetchAll);
router.post('/detaisls', MonitoringController.details);

export default router;
