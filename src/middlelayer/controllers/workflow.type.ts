export type WorkflowModule =
  | 'TRANSACTIONAL'
  | 'OPERATIONAL'
  | 'SYSTEM_ACCESS';

export type WorkflowSubModule =
  | 'ACCOUNTS'
  | 'PAYMENTS'
  | 'PURCHASE'
  | 'FIN_OPS'
  | 'MASTER'
  | 'ORG_STR'
  | 'USER_ACC'
  | 'WORK_FLOW';

export type WorkflowNodeType =
  | 'ROOT'
  | 'DIVISION'
  | 'DEPARTMENT'
  | 'TEAM'
  | 'PLANT'
  | 'LOCATION';

export type WorkflowApproverType =
  | 'GLOBAL_APPROVER'
  | 'REPORTING_MANAGER'
  | 'NODE_APPROVER'
  | 'HIERARCHY_APPROVER';

export type WorkflowApprovalType = 'AND' | 'OR';

export type WorkflowRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export type WorkflowOrgStructure = {
  nodePath: string;
  nodeName: string;
  nodeType: WorkflowNodeType;
};

export type WorkflowActiveLevel = {
  level: number;
  approver1: WorkflowApproverType;
  approver2: WorkflowApproverType | null;
  approverType: WorkflowApprovalType;
};

export type WorkflowActiveItem = {
  id: string;
  nodeId: string;
  workflowReqIds: string[];
  name: string;
  alias: string;
  module: WorkflowModule;
  subModule: WorkflowSubModule;
  orgStructure: WorkflowOrgStructure;
  levelsHash: string;
  levels: WorkflowActiveLevel[];
};

export type WorkflowPendingLevel = {
  type: WorkflowApprovalType;
  approver1: WorkflowApproverType;
  approver2?: WorkflowApproverType | null;
};

export type WorkflowPendingLevels = {
  l1?: WorkflowPendingLevel | null;
  l2?: WorkflowPendingLevel | null;
  l3?: WorkflowPendingLevel | null;
  l4?: WorkflowPendingLevel | null;
  l5?: WorkflowPendingLevel | null;
};

export type WorkflowPendingRequestData = {
  name: string;
  levels?: WorkflowPendingLevels;
  module: WorkflowModule;
  nodePath: string;
  subModule: WorkflowSubModule;
  levelsHash: string | null;
  companyCode: string;
  [key: string]: unknown;
};

export type WorkflowInitiator = {
  name: string;
  email: string;
};

export type WorkflowPendingItem = {
  id: string;
  nodeId: string;
  workflowId: string | null;
  data: WorkflowPendingRequestData;
  status: 'PENDING';
  alias: string;
  approvalRemark: string | null;
  levelsHash: string;
  createdAt: string;
  initiator: WorkflowInitiator;
  initiatorTimestamp: string;
  nodeType: WorkflowNodeType | null;
  nodeName: string | null;
  nodePath: string | null;
  workflowName: string;
};

export type FetchWorkflowsData = {
  active: WorkflowActiveItem[];
  pending: WorkflowPendingItem[];
};

export type FetchWorkflowsResponse = {
  message: 'Workflows fetched successfully!';
  code: 200;
  data: FetchWorkflowsData;
};

export type WorkflowApiErrorResponse = {
  message?: string;
  error?: string;
};

export type FetchWorkflowsInternalResponse =
  | FetchWorkflowsData
  | WorkflowApiErrorResponse;
