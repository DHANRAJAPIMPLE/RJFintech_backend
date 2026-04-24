import { Router } from 'express';
import { OnboardingController } from '../controllers/onboarding.controller';
import { authMiddleware } from '../middlewares/auth.middleware';

const router = Router();

// All onboarding routes require authentication
router.use(authMiddleware);

router.post('/company/initiate', OnboardingController.initiateCompanyOnboarding);
router.post('/company/action', OnboardingController.actionCompanyOnboarding);

router.post('/user/initiate', OnboardingController.initiateUserOnboarding);
router.post('/user/action', OnboardingController.actionUserOnboarding);

export default router;
