import { Router } from 'express';
import { NotificationDbController } from '../modules/notifications/notification.db.modules';

const router = Router();

router.post('/fetch', NotificationDbController.fetch);
router.post('/read', NotificationDbController.markRead);

export default router;
