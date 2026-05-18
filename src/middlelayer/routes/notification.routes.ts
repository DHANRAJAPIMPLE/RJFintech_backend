import { Router } from 'express';
import { NotificationController } from '../controllers/notification.controller';
import { authMiddleware } from '../middlewares/auth.middleware';

const router = Router();

router.use(authMiddleware);

router.get('/sse', NotificationController.stream);
router.post('/fetch', NotificationController.fetch);
router.post('/read', NotificationController.markRead);

export default router;
