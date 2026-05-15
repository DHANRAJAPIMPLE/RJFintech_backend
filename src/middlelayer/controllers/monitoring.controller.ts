import { Request, Response, NextFunction } from 'express';
import { internalPost } from '../utils/internal-fetch.util';
import { config } from '../config';

/**
 * MONITORING CONTROLLER:
 * Exposes API observability data to SAAS Admins.
 */
export class MonitoringController {
  /**
   * Proxies request to fetch all traces.
   */
  static async fetchAllTraces(req: Request, res: Response, next: NextFunction) {
    try {
      const response = await internalPost(
        `${config.backendUrl}/internal/monitoring/fetch-all`,
        {}
      );

      if (!response.ok) {
        return res.status(response.status).json(response.data);
      }

      res.status(200).json(response.data);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Proxies request to fetch specific trace details.
   */
  static async getTraceDetails(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.body;

      if (!id) {
        return res.status(400).json({ error: 'id is required' });
      }

      const response = await internalPost(
        `${config.backendUrl}/internal/monitoring/details`,
        { id }
      );

      if (!response.ok) {
        return res.status(response.status).json(response.data);
      }

      res.status(200).json(response.data);
    } catch (error) {
      next(error);
    }
  }
}
