import type { Response, NextFunction } from 'express';
import { AppError } from '../../shared/middlewares/error.middleware';
import { config } from '../config';
import { internalPost } from '../utils/internal-fetch.util';

export class OrgStructureController {
  static async initiateOrgRequest(req: any, res: Response, next: NextFunction) {
    try {
      const { companyCode, newNodeName, nodeType, parentNode } = req.body;
      const initiator_id = req.user?.id;

      if (!initiator_id) {
        throw new AppError('Unauthorized', 401);
      }

      // Forward to Backend (5001)
      const { data, ok, status } = await internalPost(`${config.backendUrl}/internal/org/initiate`, {
        companyCode,
        newNodeName,
        nodeType,
        parentNode,
        initiator_id,
      });

      if (!ok) {
        throw new AppError(data.message || 'Failed to initiate org structure request', status);
      }

      res.status(status).json(data);
    } catch (error) {
      next(error);
    }
  }

  static async approveOrgRequest(req: any, res: Response, next: NextFunction) {
    try {
      const { requestId, remarks } = req.body;
      const approver_id = req.user?.id;

      if (!approver_id) {
        throw new AppError('Unauthorized', 401);
      }

      // Forward to Backend (5001)
      const { data, ok, status } = await internalPost(`${config.backendUrl}/internal/org/approve`, {
        requestId,
        approver_id,
        remarks,
      });

      if (!ok) {
        throw new AppError(data.message || 'Failed to approve org structure request', status);
      }

      res.status(status).json(data);
    } catch (error) {
      next(error);
    }
  }

  static async fetchOrgStructure(req: any, res: Response, next: NextFunction) {
    try {
      const { companyCode } = req.body;
      const userId = req.user?.id;

      if (!userId) {
        throw new AppError('Unauthorized', 401);
      }

      // Forward to Backend (5001)
      const { data, ok, status } = await internalPost(`${config.backendUrl}/internal/org/fetch`, {
        companyCode,
      });

      if (!ok) {
        throw new AppError(data.message || 'Failed to fetch org structure', status);
      }

      res.status(status).json(data);
    } catch (error) {
      next(error);
    }
  }
}
