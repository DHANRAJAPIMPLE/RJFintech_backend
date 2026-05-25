export type FetchMonitoringSpanItem = {
  trackingId: string;
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

export type FetchMonitoringSpanInternalItem = FetchMonitoringSpanItem & {
  subCount: string | null;
};

export type MonitoringJsonValue =
  | string
  | number
  | boolean
  | null
  | MonitoringJsonValue[]
  | {
      [key: string]: MonitoringJsonValue | undefined;
    };

export type MonitoringLoggedPayload = {
  header: {
    [key: string]: MonitoringJsonValue | undefined;
  } | null;
  body: MonitoringJsonValue;
};

export type MonitoringDetailsSpan = {
  trackingId?: string | null;
  subCount: string | null;
  type?: string | null;
  method: string | null;
  apiUrl: string | null;
  statusCode: number | null;
  ip: string | null;
  createdAt: string | null;
  latency: number | null;
  req: MonitoringLoggedPayload | null;
  res: MonitoringLoggedPayload | null;
};

export type MonitoringDetailsParentSpan = MonitoringDetailsSpan & {
  trackingId: string | null;
  type: string | null;
};

export type MonitoringDetailsChildSpan = MonitoringDetailsSpan;

export type FetchMonitoringDetailsRequest = {
  trackingId?: string | null;
  trackId?: string | null;
  // eslint-disable-next-line @typescript-eslint/naming-convention -- External request alias.
  tracking_id?: string | null;
  [key: string]: MonitoringJsonValue | undefined;
};

export type FetchMonitoringDetailsResponse = {
  parent: MonitoringDetailsParentSpan | null;
  child: MonitoringDetailsChildSpan[];
};

export type MonitoringApiErrorResponse = {
  message?: string;
  error?: string;
};

export type FetchMonitoringSpansInternalResponse =
  | FetchMonitoringSpanInternalItem[]
  | MonitoringApiErrorResponse;

export type FetchMonitoringDetailsInternalResponse =
  | FetchMonitoringDetailsResponse
  | MonitoringApiErrorResponse;
