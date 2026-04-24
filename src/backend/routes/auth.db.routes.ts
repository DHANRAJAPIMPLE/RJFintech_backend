import { Router } from 'express';
import { AuthDbController } from '../modules/auth/auth.db.modules';

const router = Router();

router.post('/register', AuthDbController.register);
router.post('/login', AuthDbController.login);
router.post('/refresh', AuthDbController.refreshToken);
router.post('/logout', AuthDbController.logout);
router.post('/verify-session', AuthDbController.verifySession);
router.post('/me', AuthDbController.getMe);

export default router;
