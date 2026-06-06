import { Router } from 'express';
import { UserDbController } from '../modules/user/user.db.modules';

const router = Router();

router.post('/fetch-all', UserDbController.fetchAllUsers);
router.post('/details', UserDbController.fetchUserDetails);
router.post('/filter-option', UserDbController.fetchUserFilterOptions);
router.post('/update-status', UserDbController.updateUserStatus);
router.post('/create', UserDbController.createUserOnboarding);
router.post('/get', UserDbController.getUserOnboardingById);
router.post('/action', UserDbController.handleUserOnboardingStatus);
router.post('/history', UserDbController.getUserHistory);
router.post('/history-detail', UserDbController.getUserHistoryDetail);
router.post('/get-pending-users', UserDbController.getPendingUsers);
router.post('/fetch-company-nodes', UserDbController.fetchCompanyNodes);
router.post(
  '/fetch-users-by-nodepath-count',
  UserDbController.fetchUsersByNodePathCount,
);
router.post('/check-global', UserDbController.checkGlobalUserStatus);

export default router;
