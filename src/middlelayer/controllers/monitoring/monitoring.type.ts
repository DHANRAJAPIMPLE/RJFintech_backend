export type FetchMonitoringSpanItem = {
  trackingId: string;
  apiUrl: string;
  statusCode: number | null;
  responseSize: string | null;
  ip: string | null;
  spanCount: number;
  companyName: string | null;
  companyCode: string | null;
  userName: string | null;
  userEmail: string | null;
  createdAt: string;
};

export type MonitoringListPageInfo = {
  page: number;
  nextCursor: string | null;
  prevCursor: string | null;
  topCursor: string | null;
  hasNext: boolean;
  hasPrev: boolean;
  hasNewData: boolean;
  newCount: number;
};

export type MonitoringFilterCountItem = {
  count: number;
};

export type MonitoringUserFilterItem = MonitoringFilterCountItem & {
  userId: string;
  userName: string | null;
  userEmail: string | null;
};

export type MonitoringIpFilterItem = MonitoringFilterCountItem & {
  ip: string;
};

export type MonitoringUrlFilterItem = MonitoringFilterCountItem & {
  apiUrl: string;
};

export type MonitoringStatusFilterItem = MonitoringFilterCountItem & {
  statusCode: number;
};

export type MonitoringResponseSizeFilterItem = MonitoringFilterCountItem & {
  label: string;
  minBytes: number;
  maxBytes: number | null;
};

export type MonitoringFilterSummary = {
  users: MonitoringUserFilterItem[];
  ips: MonitoringIpFilterItem[];
  urls: MonitoringUrlFilterItem[];
  statusCodes: MonitoringStatusFilterItem[];
  responseSizeRanges: MonitoringResponseSizeFilterItem[];
};

export type FetchMonitoringSpansResponse = {
  data: FetchMonitoringSpanItem[];
  totalCount: number;
  pageInfo: MonitoringListPageInfo;
  filter: MonitoringFilterSummary;
};

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
  responseSize: string | null;
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
  | {
      data: FetchMonitoringSpanInternalItem[];
      totalCount: number;
      pageInfo: MonitoringListPageInfo;
      filter: MonitoringFilterSummary;
    }
  | MonitoringApiErrorResponse;

export type FetchMonitoringDetailsInternalResponse =
  | FetchMonitoringDetailsResponse
  | MonitoringApiErrorResponse;
