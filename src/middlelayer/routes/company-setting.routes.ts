/**
 * Company Setting Routes:
 * This module consolidates all routes related to company-specific configurations,
 * including User Management, Organizational Structure, Workflows, and Roles.
 *
 * Why we use it:
 * - To group related functional areas under a common /company-settings prefix.
 * - It enforces a double-layered security check:
 *   1. 'authMiddleware' for general session validity.
 *   2. 'authorize' middleware for granular, module-specific permissions
 *      (e.g., 'initiate' permission for 'USER_ACC' module).
 */
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

// --------------workflow routes------------------------------
router.post(
  '/workflow/initiate',
  authorize('initiate', 'WORK_FLOW'),
  WorkflowController.initiateWorkflow,
);
router.post(
  '/workflow/action',
  authorize('approve', 'WORK_FLOW'),
  WorkflowController.actionWorkflow,
);
router.post(
  '/workflow/fetch',
  authorize('view', 'WORK_FLOW'),
  WorkflowController.fetchAllWorkflows,
);
router.post(
  '/workflow/fetch-history',
  authorize('view', 'WORK_FLOW'),
  WorkflowController.fetchWorkflowHistory,
);

// ----------------------------------------------------------

// --------------roles routes--------------------------------
router.post('/role/create', RoleController.createRoles);
router.post('/role/fetch-all', RoleController.fetchAllRoles);
// ----------------------------------------------------------

export default router;
