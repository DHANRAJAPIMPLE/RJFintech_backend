import { Router } from 'express';
import { PreferenceController } from '../controllers/preference/preference.controller';
import { authMiddleware } from '../middlewares/auth.middleware';

const router = Router();

router.use(authMiddleware);

router.post('/user-preference', PreferenceController.fetchUserPreferences);
router.post(
  '/workflow-preference',
  PreferenceController.updateWorkflowPreferences,
);

export default router;
