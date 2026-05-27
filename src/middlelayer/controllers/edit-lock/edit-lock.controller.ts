import type { NextFunction, Response } from 'express';
import { AppError } from '../../../shared/middlewares/error.middleware';
import type { AuthRequest } from '../../middlewares/auth.middleware';
import { config } from '../../config';
import { internalPost } from '../../utils/internal-fetch.util';
import { zodParse } from '../../utils/zod-parse.util';
import { editLockSchema } from '../../validations/edit-lock.validation';
import type {
  EditLockApiErrorResponse,
  EditLockInternalResponse,
  EditLockResponse,
} from './edit-lock.type';

export class EditLockController {
  static async toggle(
    req: AuthRequest,
    res: Response<EditLockResponse>,
    next: NextFunction,
  ) {
    try {
      const validatedData = zodParse(editLockSchema, req.body);
      const userId = req.user?.id;
      const companyId = req.user?.companyId;

      if (!userId || !companyId) {
        throw new AppError('Unauthorized', 401);
      }

      const { data, ok, status } = await internalPost<EditLockInternalResponse>(
        `${config.backendUrl}/internal/edit-lock/toggle`,
        {
          ...validatedData,
          userId,
          companyId,
        },
      );

      if (!ok || !data || !('lockAcquired' in data)) {
        const errorData = data as EditLockApiErrorResponse | null;
        throw new AppError(
          errorData?.message ||
            errorData?.error ||
            'Failed to process edit lock',
          status || 500,
        );
      }

      res.status(200).json(data);
    } catch (error) {
      next(error);
    }
  }
}
