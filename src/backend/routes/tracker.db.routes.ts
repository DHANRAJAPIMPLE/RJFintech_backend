import { Router } from 'express';
import { TrackerDbController } from '../modules/tracker/tracker.db.modules';

const router = Router();

/**
 * Internal logging routes for API Traceability and Monitoring.
 * These are called by the Middle Layer to record spans and traces.
 */
router.post('/trace', TrackerDbController.createTrace);
router.patch('/trace', TrackerDbController.updateTrace);
router.post('/span', TrackerDbController.createSpan);

export default router;
