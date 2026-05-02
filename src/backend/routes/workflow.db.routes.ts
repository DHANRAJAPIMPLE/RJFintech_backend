import { Router } from 'express';
import { WorkflowDbController } from '../modules/workflow/workflow.db.modules';

const router = Router();

router.post('/initiate', WorkflowDbController.initiateRequest);
router.post('/action', WorkflowDbController.handleWorkflowStatus);
router.post('/fetch', WorkflowDbController.fetchWorkflows);
router.post('/fetch-history', WorkflowDbController.fetchWorkflowHistory);

export default router;
