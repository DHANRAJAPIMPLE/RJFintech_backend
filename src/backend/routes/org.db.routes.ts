import { Router } from 'express';
import { OrgStructureDbController } from '../modules/org/org.db.modules';

const router = Router();

router.post('/initiate', OrgStructureDbController.initiateRequest);
router.post(
  '/validate-initiation',
  OrgStructureDbController.validateInitiation,
);

router.post('/get-request', OrgStructureDbController.getOrgRequestById);
router.post('/get-node', OrgStructureDbController.getOrgNodeByPath);
router.post('/action', OrgStructureDbController.updateOrgRequestStatus);
router.post(
  '/get-node-by-path-companyid',
  OrgStructureDbController.getOrgNodeByPathCompanyId,
);
router.post('/fetch', OrgStructureDbController.fetchStructure);
router.post('/fetch-history', OrgStructureDbController.fetchOrgHistory);
router.post('/history-detail', OrgStructureDbController.getOrgHistoryDetail);

export default router;
