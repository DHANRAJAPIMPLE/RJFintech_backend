import { Router } from 'express';
import { RolesController } from '../controllers/roles.controller';
import { authMiddleware } from '../middlewares/auth.middleware';

const router = Router();

// All roles routes require authentication
router.use(authMiddleware);

router.post('/create', RolesController.createRoles);
router.post('/fetch-all', RolesController.fetchAllRoles);

export default router;
