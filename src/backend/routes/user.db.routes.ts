import { Router } from 'express';
import { UserDbController } from '../modules/user/user.db.modules';

const router = Router();

router.post('/fetch-all', UserDbController.fetchAllUsers);
router.post('/update-status', UserDbController.updateUserStatus);
router.post('/create', UserDbController.createUserOnboarding);
router.post('/get', UserDbController.getUserOnboardingById);
router.post('/action', UserDbController.handleUserOnboardingStatus);
router.post('/history', UserDbController.getUserHistory);
router.post('/get-pending-users', UserDbController.getPendingUsers);
router.post('/fetch-company-nodes', UserDbController.fetchCompanyNodes);
router.post(
  '/fetch-users-by-nodepath-count',
  UserDbController.fetchUsersByNodePathCount,
);

export default router;
