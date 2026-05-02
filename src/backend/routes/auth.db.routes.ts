import { Router } from 'express';
import { AuthDbController } from '../modules/auth/auth.db.modules';

const router = Router();

router.post('/get-user', AuthDbController.getByUser);
router.post('/get-user-activity', AuthDbController.getActivity);
router.post('/activity/delete', AuthDbController.deleteActivity);
router.post('/activity/upsert', AuthDbController.upsertActivity);
router.post('/user/create', AuthDbController.createUser);
router.post('/get-role', AuthDbController.getUserAdminRole);
router.post('/get-user-access', AuthDbController.getUserAccess);

export default router;
