export type UserCompanyNodesSubCategory = 'USER_ACC' | 'WORK_FLOW' | 'ORG_STR';

export type UserAccessCategory = 'ALL_CHILD' | 'IMMEDIATE_CHILD' | 'NODE';

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

export type FetchCompanyNodesInternalResponse =
  | {
      nodes?: UserCompanyNodeInternal[];
      message?: string;
      error?: string;
    }
  | UserCompanyNodeInternal[];

export type FetchCompanyNodesResponse = {
  message: 'User nodes fetched successfully!' | 'User nodes not found';
  code: 200;
  data: UserCompanyNode[];
};

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
  createdAt: string;
  designation: string | null;
  employeeId: string | null;
  reportingManagerName: string | null;
  reportingManagerEmail: string | null;
};

export type UserListAccess = {
  roleCategory: string;
  roleSubCategory: string;
  roleName: string;
  nodeName: string;
  nodePath: string;
  nodeType: UserCompanyNodeType;
  accessCategory: UserAccessCategory;
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
  basicDetails: UserListBasicDetails;
  primary: UserListAccess[];
  secondary: UserListAccess[];
};

export type PendingUserApprover = {
  name: string;
  email: string;
};

export type PendingUserBasicDetails = UserListBasicDetails & {
  status?: string | null;
  initiatorName: string | null;
  initiatorEmail: string | null;
  initiatedDate: string;
  workflowName: string;
  alias: string;
};

export type PendingUserAccess = Omit<UserListAccess, 'nodeType'> & {
  nodeType?: UserCompanyNodeType;
};

export type PendingUserListItem = {
  id: string;
  type?: string;
  impact?: string | null;
  oldData?: unknown | null;
  newData?: unknown | null;
  basicDetails: PendingUserBasicDetails;
  primary: PendingUserAccess[];
  secondary: PendingUserAccess[];
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
  pendingUsers: PendingUserListItem[];
  inactiveUsers: UserListItem[];
  activeCount: number;
  inactiveCount: number;
  pendingCount: number;
  limit: number;
  offset: number;
  pageInfo: UserListPageInfo;
};

export type FetchAllUsersResponse = {
  data: UserListItem[] | PendingUserListItem[];
  activeCount: number;
  inactiveCount: number;
  pendingCount: number;
  pageInfo: UserListPageInfo;
};

export type InitiateUserOnboardingResponse =
  | {
      message: 'User onboarding initiated successfully';
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

export type UserHistoryChangeCount = {
  added: number;
  modify: number;
  remove: number;
};

export type UserHistoryEvent = 'INITIATE' | 'APPROVED' | 'REJECTED' | 'MODIFY';

export type UserHistoryPendingApprovalEvent = `L${number} Pending Approval`;
export type UserHistoryLevelCount = 'I' | `M${number}` | `A${number}` | null;

export type UserHistoryBaseItem = {
  id: string;
  email: string;
  changeCount: UserHistoryChangeCount;
  levelCount: UserHistoryLevelCount;
};

export type UserHistoryActionItem = UserHistoryBaseItem & {
  event: UserHistoryEvent;
  level: number | null;
  createdAt: string;
  remarks: string | null;
  user: UserHistoryAuditUser;
};

export type UserHistoryPendingApprovalItem = UserHistoryBaseItem & {
  event: UserHistoryPendingApprovalEvent;
  createdAt: null;
  eligibleapprovers: UserHistoryAuditUser[];
};

export type UserHistoryItem =
  | UserHistoryActionItem
  | UserHistoryPendingApprovalItem;

export type FetchUserHistoryResponse = {
  message: 'User history fetched successfully!';
  code: 200;
  data: UserHistoryItem[];
};

export type UserHistoryInternalItem = UserHistoryItem & {
  oldData?: unknown | null;
  companyCode: string;
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
  | UserOnboardingInternalResponse
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
