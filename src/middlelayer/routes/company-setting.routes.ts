import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import { OrgController } from '../controllers/org.controller';
import { RoleController } from '../controllers/role.controller';
import { UserController } from '../controllers/user.controller';
import { WorkflowController } from '../controllers/workflow.controller';
import { authorize } from '../middlewares/access.middleware';

const router = Router();
router.use(authMiddleware);

// -------------user routes----------------------------------
router.post(
  '/user/initiate',
  authorize('initiate', 'USER_ACC'),
  UserController.initiateUserOnboarding,
);
router.post(
  '/user/action',
  authorize('approve', 'USER_ACC'),
  UserController.actionUserOnboarding,
);
router.post(
  '/user/fetch-all-users',
  authorize('view', 'USER_ACC'),
  UserController.fetchAllUsers,
);
router.post(
  '/user/update-status',
  authorize('modify', 'USER_ACC'),
  UserController.updateUserStatus,
);
router.post(
  '/user/fetch-history',
  authorize('view', 'USER_ACC'),
  UserController.getUserHistory,
);
// ----------------------------------------------------------

//--------------org routes-----------------------------------
router.post(
  '/org/initiate',
  authorize('initiate', 'ORG_STR'),
  OrgController.initiateOrgRequest,
);
router.post(
  '/org/approve',
  authorize('approve', 'ORG_STR'),
  OrgController.approveOrgRequest,
);
router.post(
  '/org/fetch',
  authorize('view', 'ORG_STR'),
  OrgController.fetchOrgStructure,
);
router.post(
  '/org/fetch-history',
  authorize('view', 'ORG_STR'),
  OrgController.fetchOrgHistory,
);
// ----------------------------------------------------------

// --------------roles routes--------------------------------
router.post('/role/create', RoleController.createRoles);
router.post('/role/fetch-all', RoleController.fetchAllRoles);
// ----------------------------------------------------------

// --------------workflow routes------------------------------
router.post('/workflow/initiate', WorkflowController.initiateWorkflow);
router.post('/workflow/action', WorkflowController.approveWorkflowAction);
router.post('/workflow/fetch', WorkflowController.fetchWorkflows);
router.post('/workflow/fetch-history', WorkflowController.fetchWorkflowHistory);
// ----------------------------------------------------------

export default router;
