import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import authDbRoutes from './routes/auth.db.routes';
import companyDbRoutes from './routes/company.db.routes';
import userDbRoutes from './routes/user.db.routes';
import onboardingDbRoutes from './routes/onboarding.db.routes';
import rolesDbRoutes from './routes/roles.db.routes';
import orgDbRoutes from './routes/org.db.routes';
import { createErrorMiddleware } from '../shared/middlewares/error.middleware';

const app1 = express();

app1.use(
  cors({
    origin: true,
    credentials: true,
  }),
);
app1.use(express.json());
app1.use(cookieParser());

// Internal Routes
app1.use('/internal/auth', authDbRoutes);
app1.use('/internal/company', companyDbRoutes);
app1.use('/internal/user', userDbRoutes);
app1.use('/internal/onboarding', onboardingDbRoutes);
app1.use('/internal/roles', rolesDbRoutes);
app1.use('/internal/org', orgDbRoutes);

// Health check
app1.get('/', (req, res) => {
  res.json({ message: 'Backend Database Service is running on port 5001' });
});

// Error handling middleware (should be last)
app1.use(createErrorMiddleware('BackendService'));

export { app1 };
