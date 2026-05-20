export type FetchMonitoringSpanItem = {
  trackingId: string;
  subCount: string | null;
  apiUrl: string;
  statusCode: number | null;
  ip: string | null;
  spanCount: number;
  companyName: string | null;
  companyCode: string | null;
  userName: string | null;
  userEmail: string | null;
  createdAt: string;
};

export type FetchMonitoringSpansResponse = FetchMonitoringSpanItem[];

export type MonitoringApiErrorResponse = {
  message?: string;
  error?: string;
};

export type FetchMonitoringSpansInternalResponse =
  | FetchMonitoringSpansResponse
  | MonitoringApiErrorResponse;
