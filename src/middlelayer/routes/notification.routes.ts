import { Router } from 'express';
import { NotificationController } from '../controllers/notification/notification.controller';
import { authMiddleware } from '../middlewares/auth.middleware';

const router = Router();

router.use(authMiddleware);

router.get('/sse', NotificationController.stream); //done
router.post('/fetch', NotificationController.fetch);  //done
router.post('/read', NotificationController.markRead); //done

export default router;
