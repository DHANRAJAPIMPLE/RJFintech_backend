import { Router } from 'express';
import { UserController } from '../controllers/user.controller';
import { authMiddleware } from '../middlewares/auth.middleware';

const router = Router();

// Logic: Protected route — only authenticated users can fetch the user list
router.post('/fetch-all-users', authMiddleware, UserController.fetchAllUsers);

export default router;
