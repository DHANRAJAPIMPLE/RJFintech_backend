import { Router } from 'express';
import { PreferenceDbController } from '../modules/preferences/workflow-preference.db.modules';

const router = Router();

router.post('/user-preference', PreferenceDbController.fetchUserPreferences);
router.post(
  '/workflow-preference',
  PreferenceDbController.updateWorkflowPreferences,
);

export default router;
