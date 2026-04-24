import { Router } from 'express';
import { OrgStructureController } from '../controllers/org.controller';
import { authMiddleware } from '../middlewares/auth.middleware';

const router = Router();

// All org structure routes require authentication
router.use(authMiddleware);

router.post('/initiate', OrgStructureController.initiateOrgRequest);
router.post('/approve', OrgStructureController.approveOrgRequest);
router.post('/fetch', OrgStructureController.fetchOrgStructure);

export default router;
