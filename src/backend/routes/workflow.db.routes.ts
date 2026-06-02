import { Router } from 'express';
import { WorkflowDbController } from '../modules/workflow/workflow.db.modules';

import { OrgStructureDbController } from '../modules/org/org.db.modules';
const router = Router();

router.post('/initiate', WorkflowDbController.initiateWorkflowRequest);
router.post('/get-node', OrgStructureDbController.getOrgNodeByPath);
router.post(
  '/get-node-by-company',
  OrgStructureDbController.getOrgNodeByPathCompanyId,
);
router.post('/history', WorkflowDbController.fetchWorkflowHistory);
router.post('/history-detail', WorkflowDbController.getWorkflowHistoryDetail);
router.post('/get-request', WorkflowDbController.getWorkflowRequestByHash);
router.post('/action', WorkflowDbController.actionWorkflowRequest);
router.post('/fetch', WorkflowDbController.fetchWorkflows);

export default router;
