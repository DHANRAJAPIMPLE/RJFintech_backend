import { Router } from 'express';
import { UserDbController } from '../modules/user/user.db.modules';

const router = Router();

router.post('/fetch-all', UserDbController.fetchAllUsers);

export default router;
