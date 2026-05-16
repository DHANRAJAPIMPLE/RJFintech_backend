import { Router } from 'express';
import { MonitoringController } from '../modules/monitoring/monitoring.controller';

const router = Router();

router.post('/api-span', MonitoringController.createMiddlelayerApiSpan);
router.post('/fetch-all', MonitoringController.fetchAll);
router.post('/detaisls', MonitoringController.details);

export default router;
