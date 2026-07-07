import { Router } from 'express';
import { EditLockDbController } from '../modules/edit-lock/edit-lock.db.modules';

const router = Router();

router.post('/toggle', EditLockDbController.toggle);

export default router;
