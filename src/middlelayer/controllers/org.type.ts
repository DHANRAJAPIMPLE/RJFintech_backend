export type OrgNodeType =
  | 'ROOT'
  | 'DIVISION'
  | 'DEPARTMENT'
  | 'TEAM'
  | 'PLANT'
  | 'LOCATION';

export type OrgActiveNode = {
  id: string;
  nodeId: string;
  nodeName: string;
  nodeType: OrgNodeType;
  nodePath: string;
};

export type OrgParentNode = {
  nodeName: string;
  nodePath: string;
};

export type OrgPendingRequestData = {
  newNodeName: string;
  nodeType: OrgNodeType;
  parentNode: OrgParentNode;
  [key: string]: unknown;
};

export type OrgPendingInitiator = {
  name: string;
  email: string;
};

export type OrgPendingInternalItem = {
  id: string;
  data: OrgPendingRequestData;
  createdAt: string;
  initiator?: OrgPendingInitiator | null;
  workflowName: string;
  alias: string;
};

export type OrgPendingItem = {
  id: string;
  newNodeName: string;
  nodeType: OrgNodeType;
  parentNode: OrgParentNode;
  initiatorName: string | null;
  initiatorEmail: string | null;
  initiatedDate: string;
  workflowName: string;
  alias: string;
};

export type FetchOrgStructureInternalSuccess = {
  message: 'Organization structure fetched successfully!';
  code: 200;
  data: {
    nodes: OrgActiveNode[];
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

export type OrgApiErrorResponse = {
  message?: string;
  error?: string;
};

export type FetchOrgStructureInternalResponse =
  | FetchOrgStructureInternalSuccess
  | OrgApiErrorResponse;
