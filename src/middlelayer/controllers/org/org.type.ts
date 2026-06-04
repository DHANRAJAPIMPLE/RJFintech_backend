export type OrgNodeType =
  | 'ROOT'
  | 'DIVISION'
  | 'DEPARTMENT'
  | 'TEAM'
  | 'PLANT'
  | 'LOCATION';

export type OrgNodeStatus = 'ACTIVE' | 'INACTIVE';

export type OrgActiveNode = {
  nodeName: string;
  nodeType: OrgNodeType | null;
  nodePath: string;
  isPending: boolean;
  status?: OrgNodeStatus;
  isAutoDeleted?: boolean;
  linkedOrgStructure?: OrgActiveNode[];
};

export type OrgActiveNodeInternal = OrgActiveNode & {
  id: string;
  nodeId: string;
};

export type OrgParentNode = {
  nodeName: string;
  nodePath: string;
};

export type OrgPendingRequestData = {
  newNodeName: string;
  nodeType: OrgNodeType;
  parentNode: OrgParentNode;
  nodePath?: string;
  status?: 'ACTIVE' | 'INACTIVE';
  [key: string]: unknown;
};

export type OrgPendingInitiator = {
  name: string;
  email: string;
};

export type OrgPendingInternalItem = {
  id: string;
  type?: 'INITIATE' | 'UPDATE';
  impact?: string | null;
  oldData?: unknown | null;
  newData?: unknown | null;
  data: OrgPendingRequestData;
  createdAt: string;
  initiator?: OrgPendingInitiator | null;
  workflowName: string;
  alias: string;
};

export type OrgPendingItem = {
  id: string;
  type?: 'INITIATE' | 'UPDATE';
  impact?: string | null;
  oldData?: unknown | null;
  newData?: unknown | null;
  newNodeName: string;
  nodeType: OrgNodeType;
  status?: 'ACTIVE' | 'INACTIVE' | null;
  parentNode: OrgParentNode;
  initiatorName: string | null;
  initiatorEmail: string | null;
  initiatedDate: string;
  workflowName: string;
  alias: string;
};

export type OrgPendingRequestSnapshot = {
  id: string;
  type?: 'INITIATE' | 'UPDATE';
  impact?: string | null;
  status?: string | null;
  oldData?: unknown | null;
  newData?: unknown | null;
  createdAt?: string | null;
};

export type InitiateOrgRequestResponse = {
  success: true;
  message: 'Org structure request initiated';
};

export type ApproveOrgRequestResponse = {
  success: true;
  message: string;
  nodePath: string;
};

export type RejectOrgRequestResponse = {
  success: true;
  message: 'Org structure request rejected';
};

export type OrgRequestActionResponse =
  | ApproveOrgRequestResponse
  | RejectOrgRequestResponse;

export type OrgCompanyLookupInternalResponse = {
  id: string;
  companyCode: string;
  message?: string;
  error?: string;
};

export type OrgInitiateInternalResponse = {
  id?: string;
  message?: string;
  error?: string;
};

export type OrgValidateInitiationInternalResponse = {
  success: boolean;
  message?: string;
  error?: string;
};

export type OrgStructureRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export type OrgStructureRequestInternal = {
  id: string;
  status: OrgStructureRequestStatus;
  type?: 'INITIATE' | 'UPDATE';
  company: {
    id?: string;
    companyCode: string;
  };
  data: OrgPendingRequestData;
  oldData?: unknown | null;
  eligibleApprovers?: string[];
  message?: string;
  error?: string;
};

export type OrgNodeInternal = {
  id: string;
  companyId?: string;
  nodeName: string;
  nodeType: OrgNodeType;
  nodePath: string;
  parentId?: string | null;
  status?: 'ACTIVE' | 'INACTIVE';
};

export type OrgActionInternalResponse = {
  success?: boolean;
  message?: string;
  error?: string;
  data?: {
    status?: 'APPROVED' | 'REJECTED' | 'PARTIAL_APPROVED';
    level?: number | null;
  };
};

export type FetchOrgStructureInternalSuccess = {
  message: 'Organization structure fetched successfully!';
  code: 200;
  data: {
    nodes: OrgActiveNodeInternal[];
    pending: OrgPendingInternalItem[];
  };
};

export type FetchOrgStructureData = {
  active: OrgActiveNode[];
  pending: OrgPendingItem[];
};

export type FetchOrgStructureResponse = {
  message: 'Organization structure fetched successfully!';
  code: 200;
  data: FetchOrgStructureData;
};

export type OrgHistoryAuditUser = {
  name: string;
  email: string;
};

export type OrgHistoryEvent =
  | 'INITIATE'
  | 'APPROVED'
  | 'REJECTED'
  | 'MODIFY'
  | 'AUTO_GENERATE'
  | 'AUTO_DELETE';

export type OrgHistoryPendingApprovalEvent = `L${number} Pending Approval`;

export type OrgHistoryBaseItem = {
  id: string;
  newNodeName: string | null;
  nodeType: OrgNodeType | null;
  parentNodeName: string;
};

export type OrgHistoryActionItem = OrgHistoryBaseItem & {
  event: OrgHistoryEvent;
  level: number | null;
  createdAt: string;
  remarks: string | null;
  user: OrgHistoryAuditUser;
};

export type OrgHistoryPendingApprovalItem = OrgHistoryBaseItem & {
  event: OrgHistoryPendingApprovalEvent;
  createdAt: null;
  eligibleapprovers: OrgHistoryAuditUser[];
};

export type OrgHistoryItem =
  | OrgHistoryPendingApprovalItem
  | OrgHistoryActionItem;

export type FetchOrgHistoryResponse = {
  message: 'Organization structure history fetched successfully!';
  code: 200;
  data: OrgHistoryItem[];
};

export type OrgHistoryInternalItem = OrgHistoryItem & {
  oldData?: unknown | null;
  orgReqId: string;
  companyCode: string;
  nodeId: string | null;
  orgStructureId: string | null;
  nodePath: string | null;
  parentNodePath: string;
};

export type FetchOrgHistoryInternalSuccess = {
  message: 'Organization structure history fetched successfully!';
  code: 200;
  data: OrgHistoryInternalItem[];
};

export type OrgApiErrorResponse = {
  message?: string;
  error?: string;
};

export type FetchOrgStructureInternalResponse =
  | FetchOrgStructureInternalSuccess
  | OrgApiErrorResponse;

export type FetchOrgHistoryInternalResponse =
  | FetchOrgHistoryInternalSuccess
  | OrgApiErrorResponse;
