import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import authRoutes from './routes/auth.routes';
import companyRoutes from './routes/company.routes';
import userRoutes from './routes/user.routes';
import onboardingRoutes from './routes/onboarding.routes';
import rolesRoutes from './routes/roles.routes';
import orgRoutes from './routes/org.routes';
import { createErrorMiddleware } from '../shared/middlewares/error.middleware';
import { allowedNodeEnvironmentFlags } from 'process';
const allowedOrigins = [
  "http://localhost:5173",
  "http://192.168.1.7:8080"
]
const app = express();

app.use(cors({
  origin:(origin, callback)=>{
    if(!origin || allowedOrigins.includes(origin)){
      callback(null,true)
    }else{
      callback(new Error("Not allowed by CORS"))
    }
  }, // Allow all for dev, or specify frontend URL
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// Request Logger


// Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/company', companyRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/onboarding', onboardingRoutes);
app.use('/api/v1/roles', rolesRoutes);
app.use('/api/v1/org', orgRoutes);

// Health check
app.get('/', (req, res) => {
  res.json({ message: 'middle layer server is running with Auth support' });
});

// Error handling middleware (should be last)
app.use(createErrorMiddleware('MiddleLayer'));
app.use((req, res, next) => {
  if(allowedOrigins.includes(req.headers.origin)){
    res.header('Access-Control-Allow-Origin', req.headers.origin);
    res.header('Access-Control-Allow-Credentials', 'true');  
  
  }
  next();
})

export { app };
