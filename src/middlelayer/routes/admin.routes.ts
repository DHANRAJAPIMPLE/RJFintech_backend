import { Router } from 'express';
import { AdminController } from '../controllers/admin.controller';
import { authMiddleware } from '../middlewares/auth.middleware';

/**
 * ADMIN ROUTES LOGIC:
 * Defines endpoints for system-wide administrative tasks.
 */
const router = Router();
router.use(authMiddleware);

// -------------company routes------------------------------
router.post('/groups', AdminController.getGroupCompanies);
// ----------------------------------------------------------

export default router;
