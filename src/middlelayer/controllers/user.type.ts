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
};

export type UserCompanyNode = {
  nodeName: string;
  nodePath: string;
  nodeType: UserCompanyNodeType;
  workflows: UserCompanyNodeWorkflow[];
  roleName: string;
};

export type FetchCompanyNodesInternalResponse =
  | {
      nodes?: UserCompanyNode[];
      message?: string;
      error?: string;
    }
  | UserCompanyNode[];

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

export type UserListItem = {
  basicDetails: UserListBasicDetails;
  primary: UserListAccess[];
  secondary: UserListAccess[];
};

export type PendingUserApprover = {
  name: string;
  email: string;
};

export type PendingUserBasicDetails = UserListBasicDetails & {
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
  approver: PendingUserApprover | null;
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

export type FetchActiveUsersResponse = {
  data: UserListItem[];
  activeCount: number;
  inactiveCount: number;
  pendingCount: number;
  pageInfo: UserListPageInfo;
};

export type FetchPendingUsersResponse = {
  data: PendingUserListItem[];
  activeCount: number;
  inactiveCount: number;
  pendingCount: number;
  pageInfo: UserListPageInfo;
};

export type InitiateUserOnboardingResponse = {
  message: 'User onboarding initiated successfully';
};
