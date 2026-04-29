import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import authRoutes from './routes/auth.routes';
import companyRoutes from './routes/company-setting.routes';
import adminRoutes from './routes/admin.routes';
import { createErrorMiddleware } from '../shared/middlewares/error.middleware';
const allowedOrigins = ['http://localhost:8080', 'http://192.168.1.7:8080'];
const app = express();

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
  }),
);
app.use(express.json());
app.use(cookieParser());

// Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/company-settings', companyRoutes);
app.use('/api/v1/admin', adminRoutes);

app.get('/', (req, res) => {
  res.status(200).json({ message: 'OK' });
});

// Error handling middleware (should be last)

app.use(createErrorMiddleware('MiddleLayer'));
app.use((req, res, next) => {
  if (allowedOrigins.includes(req.headers.origin)) {
    res.header('Access-Control-Allow-Origin', req.headers.origin);
    res.header('Access-Control-Allow-Credentials', 'true');
  }
  next();
});

export { app };
