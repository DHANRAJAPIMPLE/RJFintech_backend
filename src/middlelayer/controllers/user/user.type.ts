export type UserCompanyNodesSubCategory = 'USER_ACC' | 'WORK_FLOW' | 'ORG_STR';

export type UserAccessCategory = 'ALL_CHILD' | 'IMMEDIATE_CHILD' | 'NODE';
export type UserAccessSourceTag = 'USER' | 'AUTO_GENERATED';

export type UserCompanyNodeType =
  | 'ROOT'
  | 'DIVISION'
  | 'DEPARTMENT'
  | 'TEAM'
  | 'PLANT'
  | 'LOCATION';

export type UserCompanyNodeWorkflow = {
  levelsHash: string;
  name: string;
  alias: string;
  status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVE' | string;
};

export type UserCompanyNode = {
  nodeName: string;
  nodePath: string;
  nodeType: UserCompanyNodeType;
  status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVE' | string;
  workflows: UserCompanyNodeWorkflow[];
  roleName: string;
};

export type UserCompanyNodeInternal = Omit<UserCompanyNode, 'roleName'> & {
  roleName?: string;
  roleCode?: string;
};

export type UserCompanyNodeFilterDesignationOption = {
  value: string;
  count: number;
};

export type UserCompanyNodeFilterNodeTypeOption = {
  value: string;
  count: number;
};

export type UserCompanyNodeFilterNodeOption = {
  value: string;
  path: string;
  count?: number;
  level?: number;
  levelCount?: string | number;
  permissionCount?: number;
};

export type UserCompanyNodeFilterUserStatusSummary = {
  active: number;
  pending: number;
  inactive: number;
};

export type UserCompanyNodeFilterPermissionSummaryItem = {
  count: number;
};

export type UserCompanyNodeFilterPermissionSummary = {
  checker: UserCompanyNodeFilterPermissionSummaryItem;
  maker: UserCompanyNodeFilterPermissionSummaryItem;
  viewer: UserCompanyNodeFilterPermissionSummaryItem;
  corpAdmin: UserCompanyNodeFilterPermissionSummaryItem;
};

export type UserCompanyNodeFilterDropdowns = {
  designation: UserCompanyNodeFilterDesignationOption[];
  nodeName: UserCompanyNodeFilterNodeOption[];
  nodeType: UserCompanyNodeFilterNodeTypeOption[];
  category: string[];
  subCategory: Record<string, string[]>;
  reportingManager: string[];
  userStatusSummary: UserCompanyNodeFilterUserStatusSummary;
  permissionSummary: UserCompanyNodeFilterPermissionSummary;
};

export type FetchCompanyNodeFilterResponse = {
  success: true;
  filter: true;
  subCategory: 'USER_ACC';
  dropdowns: UserCompanyNodeFilterDropdowns;
};

export type FetchCompanyNodeFilterInternalResponse =
  FetchCompanyNodeFilterResponse & {
    dropdowns: UserCompanyNodeFilterDropdowns & {
      nodes?: Array<{
        nodeName: string;
        nodePath: string;
        nodeType: string;
        level: number;
        levelLabel: string;
        userCount: number;
        permissionCount: number;
      }>;
    };
  };

export type FetchCompanyWorkflowFilterResponse = {
  filter?: true;
  workflowSubCategory?: 'WORK_FLOW';
  nodeName: UserCompanyNodeFilterNodeOption[];
  nodeType: UserCompanyNodeFilterNodeTypeOption[];
  subCategory: string[];
  module?: Array<{
    value: string;
    count: number;
  }>;
  checker?: Array<{
    value: number;
    count: number;
  }>;
  workflowLevels?: Array<{
    value: number;
    count: number;
  }>;
  workflowLevel?: Array<{
    value: number;
    count: number;
  }>;
  levels?: Array<{
    value: string;
    level: number;
    count: number;
  }>;
  summary?: {
    nodeCount: number;
    workflowCount: number;
    moduleCount: number;
    checkerCount: number;
    totalLevelCount: number;
    uniqueLevelCount: number;
  };
};

export type FetchCompanyWorkflowFilterInternalResponse =
  FetchCompanyWorkflowFilterResponse & {
    nodes?: Array<{
      nodeName: string;
      nodePath: string;
      nodeType: string;
      level: number;
      levelLabel: string;
      workflowCount: number;
      moduleCount: number;
      workflows: Array<{
        levelsHash: string;
        name: string;
        alias: string;
        module: string;
        subModule: string;
        status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVE' | string;
        checkerCount: number;
        levelCount: number;
        levels: Array<{
          level: number;
          label: string;
        }>;
      }>;
    }>;
  };

export type FetchCompanyNodesInternalResponse =
  | UserCompanyNodeInternal[]
  | {
      message?: string;
      error?: string;
    }
  | FetchCompanyNodeFilterInternalResponse
  | FetchCompanyWorkflowFilterInternalResponse;

export type FetchCompanyNodesResponse = {
  message: 'User nodes fetched successfully!' | 'User nodes not found';
  code: 200;
  data: UserCompanyNode[];
};

export type FetchCompanyNodesControllerResponse =
  | FetchCompanyNodesResponse
  | FetchCompanyNodeFilterResponse
  | FetchCompanyWorkflowFilterResponse;

export type UserNodePathCountPermissionLevel = 'MANAGER' | 'USER' | 'VIEWER';

export type UserNodePathCountLabel = 'Checker' | 'Maker' | 'Viewer';

export type UserNodePathCountItem = {
  label: UserNodePathCountLabel;
  count: number;
  permissionlevel: UserNodePathCountPermissionLevel;
};

export type FetchUsersByNodePathCountData = Partial<
  Record<UserCompanyNodesSubCategory, UserNodePathCountItem[]>
>;

export type FetchUsersByNodePathCountInternalResponse = {
  message?: string;
  code?: number;
  data?: FetchUsersByNodePathCountData;
  error?: string;
};

export type FetchUsersByNodePathCountResponse = {
  message: 'User counts fetched successfully!';
  code: 200;
  data: FetchUsersByNodePathCountData;
};

export type UserFilterTextOption = {
  label: string;
  value: string;
};

export type UserFilterNodeOption = UserFilterTextOption & {
  nodeName: string;
  nodePath: string;
  nodeType: string | null;
};

export type UserFilterManagerOption = UserFilterTextOption & {
  name: string | null;
  email: string;
};

export type UserFilterManagerInternalOption = UserFilterManagerOption & {
  id: string | null;
};

export type FetchAllUsersNodeAccess = 'primary' | 'secondary';

export type FetchAllUsersNodeAccessMap = Record<
  string,
  FetchAllUsersNodeAccess[]
>;

export type FetchAllUsersAppliedFilters = {
  designation?: string[] | null;
  nodeName?: {
    values?: string[] | null;
    nodeAccess?: FetchAllUsersNodeAccess | FetchAllUsersNodeAccessMap | null;
  } | null;
  nodeType?: string[] | null;
  category?: string[] | null;
  subCategory?: string[] | null;
  reportingManager?: string[] | null;
  onboardingDate?: {
    dateRange?: '7DAYS' | '15DAYS' | '1MONTH' | '1YEAR' | 'CUSTOM' | null;
    fromDate?: string | null;
    toDate?: string | null;
  } | null;
  status?: string[] | null;
  role?: string[] | null;
  currentStatus?: 'initiate' | 'modify' | null;
  hasPending?: 'yes' | 'no' | null;
};

export type FetchAllUsersPaginationRequest = {
  statusType: 'active' | 'pending' | 'inactive' | 'archive';
  query?: string;
  page?: number;
  direction?: 'next' | 'prev';
  cursor?: string | null;
  prevCursor?: string | null;
  nextCursor?: string | null;
  cursorId?: string | null;
  topCursor?: string | null;
  offset?: number;
  limit?: number;
};

export type FetchAllUsersRequest = {
  filter: boolean;
  applied: FetchAllUsersAppliedFilters | null;
  pagination: FetchAllUsersPaginationRequest;
};

export type FetchUserFilterOptionsResponse = {
  message: 'User filter options fetched successfully!';
  code: 200;
  companyCode: string;
  data: {
    designation: UserFilterTextOption[];
    department: UserFilterNodeOption[];
    category: UserFilterTextOption[];
    subCategory: UserFilterTextOption[];
    primaryNode: UserFilterNodeOption[];
    secondaryNode: UserFilterNodeOption[];
    reportingManager: UserFilterManagerOption[];
  };
};

export type FetchUserFilterOptionsInternalResponse = Omit<
  FetchUserFilterOptionsResponse,
  'data'
> & {
  data: Omit<FetchUserFilterOptionsResponse['data'], 'reportingManager'> & {
    reportingManager: UserFilterManagerInternalOption[];
  };
};

export type UserListBasicDetails = {
  name: string;
  email: string;
  phone: string;
  designation: string | null;
  nodeName?: string | null;
  nodePath?: string | null;
  nodeType?: UserCompanyNodeType | null;
  createdAt?: string;
  employeeId?: string | null;
  reportingManagerName?: string | null;
  reportingManagerEmail?: string | null;
};

export type UserListAccess = {
  roleCategory: string;
  roleSubCategory: string;
  roleName: string;
  nodeName: string;
  nodePath: string;
  nodeType?: UserCompanyNodeType;
  accessCategory: UserAccessCategory;
  sourceTag: UserAccessSourceTag;
};

export type PendingRequestSnapshot = {
  id: string;
  type?: string | null;
  impact?: string | null;
  status?: string | null;
  oldData?: unknown | null;
  newData?: unknown | null;
  createdAt?: string | null;
};

export type UserListItem = {
  isPending: boolean;
  levelCount?: number | null;
  pendingApprovalCount?: number;
  basicDetails: UserListBasicDetails;
  primary?: UserListAccess[];
  secondary?: UserListAccess[];
};

export type PendingUserApprover = {
  name: string;
  email: string;
};

export type PendingUserBasicDetails = UserListBasicDetails & {
  status?: string | null;
  initiatorName?: string | null;
  initiatorEmail?: string | null;
  initiatedDate?: string;
  workflowName?: string;
  alias?: string;
};

export type PendingUserAccess = Omit<UserListAccess, 'nodeType'> & {
  nodeType?: UserCompanyNodeType;
};

export type PendingUserListItem = {
  id: string;
  type?: string;
  impact?: string | null;
  levelCount?: number | null;
  oldData?: unknown | null;
  newData?: unknown | null;
  basicDetails: PendingUserBasicDetails;
  primary?: PendingUserAccess[];
  secondary?: PendingUserAccess[];
};

export type UserListPageInfo = {
  page: number;
  nextCursor: string | null;
  prevCursor: string | null;
  topCursor: string | null;
  hasNext: boolean;
  hasPrev: boolean;
  hasNewData: boolean;
  newCount: number;
};

export type FetchAndProcessUsersResult = {
  activeUsers: UserListItem[];
  archiveUsers: UserListItem[];
  pendingUsers: PendingUserListItem[];
  inactiveUsers: UserListItem[];
  activeCount: number;
  archiveCount: number;
  inactiveCount: number;
  pendingCount: number;
  limit: number;
  offset: number;
  pageInfo: UserListPageInfo;
};

export type FetchAllUsersResponse = {
  data: UserListItem[] | PendingUserListItem[];
  activeCount: number;
  archiveCount: number;
  inactiveCount: number;
  pendingCount: number;
  pageInfo: UserListPageInfo;
};

export type FetchUserDetailsInternalResponse = {
  message?: string;
  code?: number;
  data?: UserListItem | PendingUserListItem;
  error?: string;
};

export type FetchUserDetailsResponse = {
  message: 'User details fetched successfully!';
  code: 200;
  data: UserListItem | PendingUserListItem;
};

export type InitiateUserOnboardingResponse =
  | {
      message: string;
      autoGeneratedAccessNames?: string[];
    }
  | UserApiErrorResponse;

export type UserOnboardingStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export type UserOnboardingActionResultStatus =
  | 'APPROVED'
  | 'REJECTED'
  | 'PARTIAL_APPROVED';

export type ActionUserOnboardingResponse =
  | {
      message: string;
    }
  | UserApiErrorResponse;

export type UserHistoryAuditUser = {
  name: string;
  email: string;
};

export type UserHistoryApprovedAuditUser = {
  name?: string;
  email: string;
  levelCount: `A${number}` | `R${number}`;
  approvedAt: string | null;
} & Partial<Record<`name${number}`, string>>;

export type UserHistoryApprovalSummary = {
  currentStatus: 'APPROVED' | 'REJECTED' | 'PENDING' | null;
  totalLevels: number;
  completedLevels: number;
  rejectedAtLevel?: number | null;
};

export type UserHistoryApprovedByGroup = {
  level: number;
  rule: 'AND' | null;
  approvedBy: UserHistoryApprovedAuditUser[];
};

export type UserHistoryChangeCount = {
  added: number;
  modify: number;
  remove: number;
};

export type UserHistoryEvent =
  | 'INITIATE'
  | 'APPROVED'
  | 'REJECTED'
  | 'MODIFY'
  | 'ACTIVE'
  | 'INACTIVE'
  | 'ARCHIVE'
  | 'APPROVAL_PROGRESS'
  | `L${number} Pending Approval`;

export type UserHistoryLevelCount =
  | 'I'
  | `M${number}`
  | `A${number}`
  | `R${number}`
  | 'AR'
  | 'AC'
  | 'IN'
  | null;

export type UserHistoryBaseItem = {
  id: string;
  email: string;
};

export type UserHistoryEligibleApprover = {
  name: string;
  email: string;
};

export type UserHistoryActionItem = UserHistoryBaseItem & {
  event: UserHistoryEvent;
  level?: number | null;
  levelCount: UserHistoryLevelCount;
  createdAt: string | null;
  remarks: string | null;
  user: UserHistoryAuditUser;
  changeCount: UserHistoryChangeCount;
  approvalSummary?: UserHistoryApprovalSummary;
  approvedBy?: UserHistoryApprovedByGroup[];
  eligibleapprovers?: UserHistoryEligibleApprover[];
};

export type UserHistoryItem = UserHistoryActionItem;

export type FetchUserHistoryResponse = {
  message: 'User history fetched successfully!';
  code: 200;
  data: UserHistoryItem[];
};

export type UserHistoryInternalItem = UserHistoryActionItem & {
  oldData?: unknown | null;
  newData?: unknown | null;
  companyCode: string;
  type?: string | null;
  impact?: string | null;
  approvalLevel?: number | null;
};

export type FetchUserHistoryInternalSuccess = {
  message: 'User history fetched successfully!';
  code: 200;
  data: UserHistoryInternalItem[];
};

export type UserApiErrorResponse = {
  status?: 'error' | string;
  statusCode?: number;
  message?: string;
  error?: string;
};

export type UserOnboardingInternalResponse = {
  id: string;
  status: UserOnboardingStatus;
  eligibleApprovers?: string[];
  message?: string;
  error?: string;
  [key: string]: unknown;
};

export type CreateUserOnboardingInternalResponse =
  | (UserOnboardingInternalResponse & {
      autoGeneratedAccessNames?: string[];
    })
  | UserApiErrorResponse;

export type ActionUserOnboardingInternalResult = {
  status?: UserOnboardingActionResultStatus;
  level?: number | null;
  [key: string]: unknown;
};

export type ActionUserOnboardingInternalResponse =
  | {
      message?: string;
      data?: ActionUserOnboardingInternalResult;
      error?: string;
    }
  | UserApiErrorResponse;

export type FetchUserHistoryInternalResponse =
  | FetchUserHistoryInternalSuccess
  | UserApiErrorResponse;
