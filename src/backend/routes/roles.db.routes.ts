import { Router } from 'express';
import { RolesDbController } from '../modules/roles/roles.db.modules.ts';

const router = Router();

router.post('/create', RolesDbController.createRoles);
router.post('/fetch-all', RolesDbController.fetchAllRoles);

export default router;
