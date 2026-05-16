import { config } from '../config';

export type MonitoringSpanType = 'MIDDLELAYER' | 'BACKEND' | 'EXTERNAL';

export type MiddlelayerApiSpanPayload = {
  trackingId: string;
  subCount?: string | null;
  type: MonitoringSpanType;
  method: string;
  url: string;
  statusCode?: number | null;
  headers?: unknown;
  reqBody?: unknown;
  resBody?: unknown;
  resHeaders?: unknown;
  latency?: number | null;
  ipAddress?: string | null;
  companyId?: string | null;
  userId?: string | null;
  startedAt: Date;
  endedAt: Date;
};

export const storeMiddlelayerApiSpan = async (
  payload: MiddlelayerApiSpanPayload,
): Promise<void> => {
  try {
    const response = await fetch(`${config.backendUrl}/monitoring/api-span`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      console.error(
        `[Monitoring] Failed to store middlelayer span: ${response.status} ${errorBody}`,
      );
    }
  } catch (error) {
    console.error('[Monitoring] Backend monitoring API unreachable', error);
  }
};
