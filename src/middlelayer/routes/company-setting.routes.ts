import { Router } from 'express';
import { CompanyController } from '../controllers/company.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { OrgController } from '../controllers/org.controller';
import { RoleController } from '../controllers/role.controller';
import { UserController } from '../controllers/user.controller';


const router = Router();
router.use(authMiddleware);

// -------------company routes------------------------------
router.post('/initiate', CompanyController.initiateCompanyOnboarding);
router.post('/action', CompanyController.actionCompanyOnboarding);
router.post('/fetch-history', CompanyController.fetchCompanyHistory);
// ----------------------------------------------------------

// -------------user routes----------------------------------
router.post('/user/initiate', UserController.initiateUserOnboarding);
router.post('/user/action', UserController.actionUserOnboarding);
router.post('/user/fetch-all-users', UserController.fetchAllUsers);
router.post('/user/update-status', UserController.updateUserStatus);
router.post('/user/history', UserController.getUserHistory);
// ----------------------------------------------------------

//--------------org routes-----------------------------------
router.post('/org/initiate', OrgController.initiateOrgRequest);
router.post('/org/approve', OrgController.approveOrgRequest);
router.post('/org/fetch', OrgController.fetchOrgStructure);
router.post('/org/fetch-history', OrgController.fetchOrgHistory);
// ----------------------------------------------------------

// --------------roles routes--------------------------------
router.post('/role/create', RoleController.createRoles);
router.post('/role/fetch-all', RoleController.fetchAllRoles);
// ----------------------------------------------------------

export default router;
