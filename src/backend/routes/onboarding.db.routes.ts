import { Router } from 'express';
import { OnboardingDbController } from '../modules/onboarding/onboarding.db.modules';

const router = Router();

// --- Company Onboarding ---
router.post('/company/check-code', OnboardingDbController.checkCompanyCode);
router.post('/group/check-code', OnboardingDbController.checkGroupCode);
router.post('/group/check-name', OnboardingDbController.checkGroupName);

// --- User Onboarding ---
router.post('/user/check-manager', OnboardingDbController.getManagerInfo);
router.post('/user/check-exists', OnboardingDbController.getUserByEmail);

router.post(
  '/global-access-ids',
  OnboardingDbController.getGlobalAccessUserIds,
);

export default router;
