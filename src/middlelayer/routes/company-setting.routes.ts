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
import type { NextFunction, Response } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import type { AuthRequest } from '../middlewares/auth.middleware';
import { AppError } from '../../shared/middlewares/error.middleware';
import { EditLockController } from '../controllers/edit-lock/edit-lock.controller';
import { HistoryController } from '../controllers/history/history.controller';
import { OrgController } from '../controllers/org/org.controller';
import { RoleController } from '../controllers/role/role.controller';
import { UserController } from '../controllers/user/user.controller';
import { WorkflowController } from '../controllers/workflow/workflow.controller';

import { authorize } from '../middlewares/access.middleware';

const router = Router();
router.use(authMiddleware);

const authorizeUserInitiate = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  const type =
    typeof req.body?.type === 'string'
      ? req.body.type.trim().toLowerCase()
      : 'initiate';

  return authorize(type === 'initiate' ? 'initiate' : 'modify', 'USER_ACC')(
    req,
    res,
    next,
  );
};

const authorizeOrgInitiate = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  const type =
    typeof req.body?.type === 'string'
      ? req.body.type.trim().toLowerCase()
      : 'initiate';

  return authorize(type === 'update' ? 'modify' : 'initiate', 'ORG_STR')(
    req,
    res,
    next,
  );
};

const authorizeWorkflowInitiate = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  const type =
    typeof req.body?.type === 'string'
      ? req.body.type.trim().toLowerCase()
      : 'initiate';

  return authorize(
    type === 'update' || type === 'inactive' || type === 'archive'
      ? 'modify'
      : 'initiate',
    'WORK_FLOW',
  )(req, res, next);
};

const authorizeEditLock = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  let moduleName: 'USER_ACC' | 'ORG_STR' | 'WORK_FLOW' | null = null;
  switch (req.body?.type) {
    case 'USER':
      moduleName = 'USER_ACC';
      break;
    case 'ORG':
      moduleName = 'ORG_STR';
      break;
    case 'WORKFLOW':
      moduleName = 'WORK_FLOW';
      break;
  }

  if (!moduleName) {
    return next(new AppError('Invalid edit lock type', 400));
  }

  return authorize('modify', moduleName)(req, res, next);
};

const authorizeHistoryDetail = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  const type =
    typeof req.body?.type === 'string'
      ? req.body.type.trim().toUpperCase()
      : '';

  const moduleName =
    type === 'USER'
      ? 'USER_ACC'
      : type === 'ORG'
        ? 'ORG_STR'
        : type === 'WORKFLOW'
          ? 'WORK_FLOW'
          : null;

  if (!moduleName) {
    return next(new AppError('Invalid history type', 400));
  }

  return authorize('view', moduleName)(req, res, next);
};

router.post('/edit-lock', authorizeEditLock, EditLockController.toggle);
router.post(
  '/history/detail',
  authorizeHistoryDetail,
  HistoryController.fetchHistoryDetail,
);

// -------------user routes----------------------------------
router.post(
  '/user/initiate',
  authorizeUserInitiate,
  UserController.initiateUserOnboarding,
);

router.post(
  '/user/action',
  authorize('approve', 'USER_ACC'),
  UserController.actionUserOnboarding,
);
router.post(
  '/user/fetch-all-user',
  authorize('view', 'USER_ACC'),
  UserController.fetchAllUsers,
);
router.post(
  '/user/user-filter-option',
  authorize('view', 'USER_ACC'),
  UserController.fetchUserFilterOptions,
);

router.post(
  '/user/fetch-history',
  authorize('view', 'USER_ACC'),
  UserController.getUserHistory,
); //done
router.post(
  '/user/fetch-company-nodes',
  authorize('initiate'),
  UserController.fetchCompanyNodes,
); //done
router.post(
  '/user/fetch-users-by-nodepath-count',
  UserController.fetchUsersByNodePathCount,
); //done

// ----------------------------------------------------------

//--------------org routes-----------------------------------
router.post(
  '/org/initiate',
  authorizeOrgInitiate,
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
); //done
router.post(
  '/org/fetch-history',
  authorize('view', 'ORG_STR'),
  OrgController.fetchOrgHistory,
); //done
// ----------------------------------------------------------

// --------------workflow routes------------------------------
router.post(
  '/workflow/initiate',
  authorizeWorkflowInitiate,
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
); //done
router.post(
  '/workflow/fetch-history',
  authorize('view', 'WORK_FLOW'),
  WorkflowController.fetchWorkflowHistory,
); //done

// ----------------------------------------------------------

// --------------roles routes--------------------------------
// router.post('/role/create', RoleController.createRoles);
router.post('/role/fetch-all', RoleController.fetchAllRoles); //done
// ----------------------------------------------------------

export default router;
