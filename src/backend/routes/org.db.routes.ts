import { Router } from 'express';
import { OrgStructureDbController } from '../modules/org/org.db.modules';

const router = Router();

router.post('/initiate', OrgStructureDbController.initiateRequest);
router.post('/approve', OrgStructureDbController.approveRequest);
router.post('/fetch', OrgStructureDbController.fetchStructure);

export default router;
