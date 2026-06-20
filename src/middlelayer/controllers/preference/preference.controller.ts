import type { NextFunction, Response } from 'express';
import { AppError } from '../../../shared/middlewares/error.middleware';
import { config } from '../../config';
import type { AuthRequest } from '../../middlewares/auth.middleware';
import { internalPost } from '../../utils/internal-fetch.util';
import { zodParse } from '../../utils/zod-parse.util';
import {
  userWorkflowPreferenceFetchSchema,
  userWorkflowPreferenceUpdateSchema,
} from '../../validations/preference.validation';
import type {
  FetchUserWorkflowPreferencesResponse,
  UpdateUserWorkflowPreferencesRequest,
  UpdateUserWorkflowPreferencesResponse,
  WorkflowPreferenceApiErrorResponse,
} from './preference.type';

export class PreferenceController {
  static async fetchUserPreferences(
    req: AuthRequest,
    res: Response<FetchUserWorkflowPreferencesResponse>,
    next: NextFunction,
  ) {
    try {
      const userId = req.user?.id;
      const companyId = req.user?.companyId;

      if (!userId || !companyId) {
        throw new AppError('Unauthorized', 401);
      }

      zodParse(userWorkflowPreferenceFetchSchema, req.body ?? {});

      const { data, ok, status } = await internalPost<
        FetchUserWorkflowPreferencesResponse | WorkflowPreferenceApiErrorResponse
      >(`${config.backendUrl}/internal/preferences/user-preference`, {
        userId,
        companyId,
      });

      if (!ok) {
        const errorData = data as WorkflowPreferenceApiErrorResponse;
        throw new AppError(
          errorData?.message ||
            errorData?.error ||
            'Failed to fetch user workflow preferences',
          status,
        );
      }

      return res
        .status(200)
        .json(data as FetchUserWorkflowPreferencesResponse);
    } catch (error) {
      return next(error);
    }
  }

  static async updateWorkflowPreferences(
    req: AuthRequest,
    res: Response<UpdateUserWorkflowPreferencesResponse>,
    next: NextFunction,
  ) {
    try {
      const userId = req.user?.id;
      const companyId = req.user?.companyId;

      if (!userId || !companyId) {
        throw new AppError('Unauthorized', 401);
      }

      const preferences = zodParse(
        userWorkflowPreferenceUpdateSchema,
        req.body ?? {},
      ) as UpdateUserWorkflowPreferencesRequest;

      const { data, ok, status } = await internalPost<
        UpdateUserWorkflowPreferencesResponse | WorkflowPreferenceApiErrorResponse
      >(`${config.backendUrl}/internal/preferences/workflow-preference`, {
        userId,
        companyId,
        eventUserId: userId,
        preferences,
      });

      if (!ok) {
        const errorData = data as WorkflowPreferenceApiErrorResponse;
        throw new AppError(
          errorData?.message ||
            errorData?.error ||
            'Failed to update workflow preferences',
          status,
        );
      }

      return res
        .status(200)
        .json(data as UpdateUserWorkflowPreferencesResponse);
    } catch (error) {
      return next(error);
    }
  }
}
