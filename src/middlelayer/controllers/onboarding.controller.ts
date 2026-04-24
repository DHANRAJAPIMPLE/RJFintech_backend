import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../shared/middlewares/error.middleware';
import { config } from '../config';
import { internalPost } from '../utils/internal-fetch.util';
import { companyOnboardingSchema, companyActionSchema, userOnboardingSchema, userActionSchema } from '../validators/onboarding.validator';

export class OnboardingController {
  static async initiateCompanyOnboarding(req: any, res: Response, next: NextFunction) {
    try {
      const validatedData = companyOnboardingSchema.parse(req.body);
      const initiator_id = req.user?.id;

      if (!initiator_id) {
        throw new AppError('Unauthorized', 401);
      }
     console.log("validatedData",validatedData)
     console.log("initiator_id",initiator_id)
     
      // Forward to Backend (5001)
      const { data, ok, status } = await internalPost(`${config.backendUrl}/internal/onboarding/company/initiate`, {
        ...validatedData,
        initiator_id
      });

      if (!ok) {
        throw new AppError(data.error || 'Failed to initiate onboarding', status);
      }
    
      res.status(201).json(data);
    } catch (error: any) {
      console.log("Error",error)
      if (error.name === 'ZodError') {
        return res.status(400).json({ error: 'Validation failed', details: error.errors });
      }
      next(error);
    }
  }

  static async actionCompanyOnboarding(req: any, res: Response, next: NextFunction) {
    try {
      const validatedData = companyActionSchema.parse(req.body);
      const approver_id = req.user?.id;

      if (!approver_id) {
        throw new AppError('Unauthorized', 401);
      }

      // Forward to Backend (5001)
      const { data, ok, status } = await internalPost(`${config.backendUrl}/internal/onboarding/company/action`, {
        ...validatedData,
        approver_id
      });

      if (!ok) {
        throw new AppError(data.error || 'Failed to process onboarding action', status);
      }

      res.status(200).json(data);
    } catch (error: any) {
      if (error.name === 'ZodError') {
        return res.status(400).json({ error: 'Validation failed', details: error.errors });
      }
      next(error);
    }
  }

  static async initiateUserOnboarding(req: any, res: Response, next: NextFunction) {
    try {
      console.log('initiateUserOnboarding req.body:', req.body);
      console.log('userOnboardingSchema:', userOnboardingSchema ? 'defined' : 'undefined');
      const validatedData = userOnboardingSchema.parse(req.body);
      const initiator_id = req.user?.id;

      if (!initiator_id) {
        throw new AppError('Unauthorized', 401);
      }

      // Forward to Backend (5001)
      const { data, ok, status } = await internalPost(`${config.backendUrl}/internal/onboarding/user/initiate`, {
        ...validatedData,
        initiator_id
      });

      if (!ok) {
        throw new AppError(data.error || 'Failed to initiate user onboarding', status);
      }

      res.status(201).json(data);
    } catch (error: any) {
      if (error.name === 'ZodError') {
        return res.status(400).json({ error: 'Validation failed', details: error.errors });
      }
      next(error);
    }
  }

  static async actionUserOnboarding(req: any, res: Response, next: NextFunction) {
    try {
      const validatedData = userActionSchema.parse(req.body);
      const approver_id = req.user?.id;

      if (!approver_id) {
        throw new AppError('Unauthorized', 401);
      }

      // Forward to Backend (5001)
      const { data, ok, status } = await internalPost(`${config.backendUrl}/internal/onboarding/user/action`, {
        ...validatedData,
        approver_id
      });

      if (!ok) {
        throw new AppError(data.error || 'Failed to process user onboarding action', status);
      }

      res.status(200).json(data);
    } catch (error: any) {
      if (error.name === 'ZodError') {
        return res.status(400).json({ error: 'Validation failed', details: error.errors });
      }
      next(error);
    }
  }
}
