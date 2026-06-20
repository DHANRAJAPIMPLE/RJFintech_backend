/**
 * Backend Database Service (Port: 5001)
 *
 * This service acts as the primary data access layer for the application.
 * Key Responsibilities:
 * - Direct interaction with the database via Prisma ORM.
 * - Atomic transactional logic for complex onboarding workflows.
 * - Centralized RBAC logic (AccessUtil).
 *
 * Security Note:
 * This service is designed to be 'Internal-Only'. It should not be exposed to the public internet.
 * The Middle-Layer Service (Port: 5000) acts as the gateway, handling authentication (JWT),
 * request validation (Zod), and business orchestration before calling these internal endpoints.
 */

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import authDbRoutes from './routes/auth.db.routes';
import companyDbRoutes from './routes/company.db.routes';
import userDbRoutes from './routes/user.db.routes';
import onboardingDbRoutes from './routes/onboarding.db.routes';
import rolesDbRoutes from './routes/roles.db.routes';
import orgDbRoutes from './routes/org.db.routes';
import workflowDbRoutes from './routes/workflow.db.routes';
import editLockDbRoutes from './routes/edit-lock.db.routes';
import monitoringDbRoutes from './routes/monitoring.db.routes';
import notificationDbRoutes from './routes/notification.db.routes';
import preferenceDbRoutes from './routes/preference.db.routes';
import { createErrorMiddleware } from '../shared/middlewares/error.middleware';
import { apiMonitoringMiddleware } from './middlewares/apiMonitoring.middleware';

const app1 = express();

app1.use(
  cors({
    origin: true,
    credentials: true,
  }),
);
app1.use(express.json());
app1.use(cookieParser());
app1.use(apiMonitoringMiddleware);

// Internal Routes - Protected by infrastructure (not intended for public access)
app1.use('/internal/auth', authDbRoutes);
app1.use('/internal/company', companyDbRoutes);
app1.use('/internal/user', userDbRoutes);
app1.use('/internal/onboarding', onboardingDbRoutes);
app1.use('/internal/roles', rolesDbRoutes);
app1.use('/internal/org', orgDbRoutes);
app1.use('/internal/workflow', workflowDbRoutes);
app1.use('/internal/edit-lock', editLockDbRoutes);
app1.use('/internal/notifications', notificationDbRoutes);
app1.use('/internal/preferences', preferenceDbRoutes);
app1.use('/monitoring', monitoringDbRoutes);

// Health check
app1.get('/', (req, res) => {
  res.json({ message: 'Backend Database Service is running on port 5001' });
});

// Global Error Handler for Backend Logic
app1.use(createErrorMiddleware('BackendService'));

export { app1 };
