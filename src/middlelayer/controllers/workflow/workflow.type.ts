export type WorkflowModule = 'TRANSACTIONAL' | 'OPERATIONAL' | 'SYSTEM_ACCESS';

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
export type WorkflowStatus = 'ACTIVE' | 'INACTIVE' | 'ARCHIVE';

export type WorkflowType = 'NODE' | 'IMMEDIATE_CHILD' | 'ALL_CHILD';

export type WorkflowActionResultStatus =
  | WorkflowRequestStatus
  | 'PARTIAL_APPROVED';

export type InitiateWorkflowResponse = {
  message: string;
};

export type WorkflowActionResponse = {
  message: string;
};

export type WorkflowOrgStructure = {
  nodePath: string;
  nodeName: string;
  nodeType: WorkflowNodeType;
  levelCount?: number | null;
};

export type WorkflowActiveLevel = {
  level: number;
  approver1: WorkflowApproverType;
  approver2: WorkflowApproverType | null;
  approverType: WorkflowApprovalType;
};

export type WorkflowLinkedOrgStructureItem = WorkflowOrgStructure;

export type WorkflowAssociateAlias = {
  workflowName: string | null;
  workflowAlias: string | null;
};

export type WorkflowActiveItem = {
  id?: string;
  name: string;
  alias: string;
  associateAlias?: WorkflowAssociateAlias;
  workflowType: WorkflowType;
  module: WorkflowModule;
  subModule: WorkflowSubModule;
  nodePath?: string;
  levelCount?: number | null;
  orgStructure: WorkflowOrgStructure;
  levelsHash?: string;
  levels?: WorkflowActiveLevel[];
  isPending: boolean;
  status?: WorkflowStatus;
  linkedOrgStructure?: WorkflowLinkedOrgStructureItem[];
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
  workflowType?: WorkflowType;
  levels?: WorkflowPendingLevels;
  module: WorkflowModule;
  nodePath: string;
  subModule: WorkflowSubModule;
  levelsHash: string | null;
  status?: WorkflowStatus | null;
};

export type WorkflowInitiator = {
  name: string;
  email: string;
};

export type WorkflowPendingItem = {
  id: string;
  workflowId?: string | null;
  data?: WorkflowPendingRequestData;
  type?: 'INITIATE' | 'UPDATE' | 'INACTIVE' | 'ACTIVE' | 'ARCHIVE';
  impact?: string | null;
  oldData?: unknown | null;
  newData?: unknown | null;
  status: 'PENDING';
  alias: string;
  module?: WorkflowModule | null;
  subModule?: WorkflowSubModule | null;
  levelCount?: number | null;
  approvalRemark?: string | null;
  levelsHash?: string;
  createdAt?: string;
  initiator?: WorkflowInitiator;
  initiatorTimestamp?: string;
  nodeType: WorkflowNodeType | null;
  nodeName: string | null;
  nodePath?: string | null;
  workflowName: string;
  associateAlias?: WorkflowAssociateAlias;
  linkedOrgStructure?: WorkflowLinkedOrgStructureItem[];
};

export type WorkflowPendingRequestSnapshot = {
  id: string;
  type?: 'INITIATE' | 'UPDATE' | 'INACTIVE' | 'ACTIVE' | 'ARCHIVE';
  impact?: string | null;
  status?: string | null;
  oldData?: unknown | null;
  newData?: unknown | null;
  createdAt?: string | null;
};

export type WorkflowListType = 'active' | 'pending' | 'inactive' | 'archive';

export type WorkflowListPageInfo = {
  page: number;
  nextCursor: string | null;
  prevCursor: string | null;
  topCursor: string | null;
  hasNext: boolean;
  hasPrev: boolean;
  hasNewData: boolean;
  newCount: number;
};

export type WorkflowPendingInternalRequestData = WorkflowPendingRequestData & {
  companyCode: string;
  [key: string]: unknown;
};

export type WorkflowPendingInternalItem = Omit<WorkflowPendingItem, 'data'> & {
  id: string;
  nodeId: string;
  workflowId: string | null;
  data: WorkflowPendingInternalRequestData;
  workflowType?: WorkflowType;
};

export type WorkflowActiveInternalItem = Omit<
  WorkflowActiveItem,
  'workflowType'
> & {
  id: string;
  createdAt: string;
  type: WorkflowType;
  status?: WorkflowStatus;
};

export type FetchWorkflowsInternalData = {
  data: WorkflowActiveInternalItem[] | WorkflowPendingInternalItem[];
  activeCount: number;
  pendingCount: number;
  inactiveCount: number;
  archiveCount: number;
  pageInfo: WorkflowListPageInfo;
};

export type FetchWorkflowsResponse = {
  message: 'Workflows fetched successfully!';
  code: 200;
  data: WorkflowActiveItem[] | WorkflowPendingItem[];
  activeCount: number;
  pendingCount: number;
  inactiveCount: number;
  archiveCount: number;
  pageInfo: WorkflowListPageInfo;
};

export type WorkflowHistoryAuditUser = {
  name: string;
  email: string;
};

export type WorkflowHistoryApprovedAuditUser = WorkflowHistoryAuditUser & {
  levelCount: `A${number}`;
  approvedAt: string;
};

export type WorkflowHistoryApprovalSummary = {
  currentStatus: string | null;
  totalLevels: number;
  completedLevels: number;
  rejectedAtLevel?: number | null;
  currentPendingLevel?: number | null;
};

export type WorkflowHistoryApprovedByGroup = {
  level: number;
  rule: 'AND' | null;
  approvedBy: WorkflowHistoryApprovedAuditUser[];
};

export type WorkflowHistoryApprovalFlowItem = {
  level: number;
  rule: 'AND' | null;
  status: string;
  approvedBy: WorkflowHistoryApprovedAuditUser[];
  approvedAt: string | null;
  eligibleapprovers: WorkflowHistoryAuditUser[];
};

export type WorkflowHistoryChangeCount = {
  added: number;
  modify: number;
  remove: number;
};

export type WorkflowHistoryLinkedWorkflow = {
  workflowId: string | null;
  workflowName: string | null;
  nodeId: string | null;
  nodeName: string | null;
  nodePath: string | null;
};

export type WorkflowHistoryEvent =
  | 'INITIATE'
  | 'APPROVED'
  | 'REJECTED'
  | 'APPROVAL_PROGRESS'
  | 'MODIFY'
  | 'ACTIVE'
  | 'INACTIVE'
  | 'ARCHIVE'
  | 'AUTO_GENERATE'
  | 'AUTO_DELETE';

export type WorkflowHistoryPendingApprovalEvent = `L${number} Pending Approval`;
export type WorkflowHistoryLevelCount =
  | 'I'
  | `M${number}`
  | `A${number}`
  | `R${number}`
  | 'AC'
  | 'IN'
  | 'AR'
  | null;

export type WorkflowHistoryBaseItem = {
  id: string;
  workflowName: string | null;
  changeCount: WorkflowHistoryChangeCount;
  levelCount: WorkflowHistoryLevelCount;
};

export type WorkflowHistoryActionItem = WorkflowHistoryBaseItem & {
  event: WorkflowHistoryEvent;
  level?: number | null;
  createdAt: string;
  remarks: string | null;
  linkedWorkflow?: WorkflowHistoryLinkedWorkflow | null;
  user: WorkflowHistoryAuditUser;
  approvalSummary?: WorkflowHistoryApprovalSummary;
  approvedBy?: WorkflowHistoryApprovedByGroup[];
};

export type WorkflowHistoryPendingApprovalItem = WorkflowHistoryBaseItem & {
  event: WorkflowHistoryPendingApprovalEvent;
  createdAt: null;
  eligibleapprovers: WorkflowHistoryAuditUser[];
  approvalSummary?: WorkflowHistoryApprovalSummary | null;
  approvedBy?: WorkflowHistoryApprovedByGroup[];
};

export type WorkflowHistoryItem =
  | WorkflowHistoryActionItem
  | WorkflowHistoryPendingApprovalItem;

export type FetchWorkflowHistoryResponse = {
  message: 'Workflow history fetched successfully!';
  code: 200;
  data: WorkflowHistoryItem[];
};

export type WorkflowHistoryInternalItem = WorkflowHistoryItem & {
  oldData?: unknown | null;
  workflowReqId: string;
  workflowId: string | null;
  nodeId: string | null;
  module: WorkflowModule | null;
  subModule: WorkflowSubModule | null;
  levelsHash: string | null;
  alias: string | null;
  nodePath: string | null;
  nodeName: string | null;
  nodeType: WorkflowNodeType | null;
  linkedWorkflow?: WorkflowHistoryLinkedWorkflow | null;
  companyCode: string;
};

export type FetchWorkflowHistoryInternalSuccess = {
  message: 'Workflow history fetched successfully!';
  code: 200;
  data: WorkflowHistoryInternalItem[];
};

export type WorkflowApiErrorResponse = {
  message?: string;
  error?: string;
};

export type WorkflowCompanyLookupInternalResponse = {
  id: string;
  companyCode: string;
  message?: string;
  error?: string;
};

export type WorkflowNodeLookupInternalResponse = {
  id: string;
  nodePath: string;
  message?: string;
  error?: string;
  [key: string]: unknown;
};

export type WorkflowRequestInternal = {
  id: string;
  status: WorkflowRequestStatus;
  eligibleApprovers?: string[];
  message?: string;
  error?: string;
  [key: string]: unknown;
};

export type WorkflowInitiateInternalResponse = {
  id?: string;
  message?: string;
  error?: string;
  [key: string]: unknown;
};

export type WorkflowActionInternalResult = {
  id?: string;
  status?: WorkflowActionResultStatus;
  level?: number | null;
  [key: string]: unknown;
};

export type WorkflowActionInternalResponse = {
  message?: string;
  error?: string;
  data?: WorkflowActionInternalResult;
};

export type FetchWorkflowsInternalResponse =
  | FetchWorkflowsInternalData
  | WorkflowApiErrorResponse;

export type FetchWorkflowHistoryInternalResponse =
  | FetchWorkflowHistoryInternalSuccess
  | WorkflowApiErrorResponse;
