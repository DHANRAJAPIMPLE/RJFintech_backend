export type HistoryLookupType = 'USER' | 'ORG' | 'WORKFLOW';

export type HistoryDetailRequest = {
  id: string;
  type: HistoryLookupType;
};

export type HistoryDetailAuditUser = {
  name: string;
  email: string;
};

export type HistoryDetailRequestSnapshot = {
  id: string;
  type: string | null;
  status: string | null;
  workflowId: string | null;
  approvalRemark?: string | null;
  createdAt: string | Date;
  module?: string | null;
  subModule?: string | null;
  levelsHash?: string | null;
  alias?: string | null;
  nodeId?: string | null;
};

export type HistoryDetailResponseData = {
  oldData: unknown | null;
  newData: unknown | null;
};

export type FetchHistoryDetailResponse = {
  message: string;
  code: number;
  data: HistoryDetailResponseData;
};

export type HistoryDetailApiErrorResponse = {
  message?: string;
  error?: string;
};

export type FetchHistoryDetailInternalSuccess = {
  message: string;
  code: number;
  data: Record<string, any>;
};

export type FetchHistoryDetailInternalResponse =
  | FetchHistoryDetailInternalSuccess
  | HistoryDetailApiErrorResponse;
