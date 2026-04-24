import { Router } from 'express';
import { OnboardingDbController } from '../modules/onboarding/onboarding.db.modules';

const router = Router();

router.post('/company/initiate', OnboardingDbController.initiate);
router.post('/company/action', OnboardingDbController.action);

router.post('/user/initiate', OnboardingDbController.initiateUser);
router.post('/user/action', OnboardingDbController.actionUser);

export default router;
