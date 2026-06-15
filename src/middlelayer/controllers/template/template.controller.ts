import type { NextFunction, Response } from 'express';
import { AppError } from '../../../shared/middlewares/error.middleware';
import { config } from '../../config';
import type { AuthRequest } from '../../middlewares/auth.middleware';
import { internalPost } from '../../utils/internal-fetch.util';
import { zodParse } from '../../utils/zod-parse.util';
import {
  templateFetchSchema,
  templateUpsertSchema,
} from '../../validations/template.validation';

export class TemplateController {
  static async upsert(
    req: AuthRequest,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const userId = req.user?.id;
      const companyId = req.user?.companyId;

      if (!userId || !companyId) {
        throw new AppError('Unauthorized', 401);
      }

      const body = zodParse(templateUpsertSchema, req.body ?? {});
      const { data, ok, status } = await internalPost(
        `${config.backendCompanyUrl}/templates/upsert`,
        {
          userId: body.userId || userId,
          companyId: body.companyId || companyId,
          templates: body.templates,
        },
      );

      if (!ok) {
        const errorData = data as { message?: string; error?: string };
        throw new AppError(
          errorData?.message || errorData?.error || 'Failed to save templates',
          status,
        );
      }

      return res.status(200).json(data);
    } catch (error) {
      return next(error);
    }
  }

  static async fetch(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user?.id;
      const companyId = req.user?.companyId;

      if (!userId || !companyId) {
        throw new AppError('Unauthorized', 401);
      }

      const body = zodParse(templateFetchSchema, req.body ?? {});
      const { data, ok, status } = await internalPost(
        `${config.backendCompanyUrl}/templates/fetch`,
        {
          userId: body.userId || userId,
          companyId: body.companyId || companyId,
        },
      );

      if (!ok) {
        const errorData = data as { message?: string; error?: string };
        throw new AppError(
          errorData?.message ||
            errorData?.error ||
            'Failed to fetch templates',
          status,
        );
      }

      return res.status(200).json(data);
    } catch (error) {
      return next(error);
    }
  }
}
