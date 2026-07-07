import type { Response, NextFunction } from 'express';
import { AppError } from '../../../shared/middlewares/error.middleware';
import { config } from '../../config';
import { internalPost } from '../../utils/internal-fetch.util';
import type { AuthRequest } from '../../middlewares/auth.middleware';
import { zodParse } from '../../utils/zod-parse.util';
import { historyDetailSchema } from '../../validations/history.validation';
import type {
  FetchHistoryDetailResponse,
  HistoryLookupType,
} from './history.type';

const historyRouteMap: Record<HistoryLookupType, string> = {
  USER: '/internal/user/history-detail',
  ORG: '/internal/org/history-detail',
  WORKFLOW: '/internal/workflow/history-detail',
};

export class HistoryController {
  static async fetchHistoryDetail(
    req: AuthRequest,
    res: Response<FetchHistoryDetailResponse>,
    next: NextFunction,
  ) {
    try {
      const { id, type } = zodParse(historyDetailSchema, req.body ?? {});

      const companyId = req.user?.companyId || req.body?.companyId;
      const userId = req.user?.id || req.body?.userId;

      const { data, ok, status } =
        await internalPost<{
          message?: string;
          code?: number;
          data?: Record<string, unknown>;
          error?: string;
        }>(
        `${config.backendUrl}${historyRouteMap[type]}`,
        {
          id,
          companyId,
          userId,
          type,
        },
      );

      if (!ok) {
        const errorData = data as { message?: string; error?: string } | null;
        throw new AppError(
          errorData?.message ||
            errorData?.error ||
            'Failed to fetch history detail',
          status,
        );
      }

      const detail = data?.data || {};
      const responseData = {
        oldData: (detail.oldData as unknown | null) ?? null,
        newData: (detail.newData as unknown | null) ?? null,
      } as FetchHistoryDetailResponse['data'];
      const response: FetchHistoryDetailResponse = {
        message: data?.message || 'History item fetched successfully!',
        code: data?.code || 200,
        data: responseData,
      };

      return res.status(response.code).json(response);
    } catch (error) {
      next(error);
    }
  }
}
