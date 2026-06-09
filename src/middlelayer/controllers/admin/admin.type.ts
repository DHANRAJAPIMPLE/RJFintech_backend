export type AdminCompanyStatus = 'ACTIVE' | 'INACTIVE';

export type AdminGroupDetails = {
  groupCode: string;
  groupName: string;
};

export type AdminCompanySignatory = {
  name: string;
  email: string;
  phone: string;
  designation: string | null;
  employeeId: string | null;
};

export type AdminActiveCompanyDetails = {
  companyCode: string;
  name: string;
  gst: string | null;
  brand: string | null;
  ieCode: string;
  registration: string;
};

export type AdminPendingCompanyDetails = {
  companyId: string;
  companyCode: string;
  name: string;
  gst: string;
  brand: string;
  iecode: string;
  registration: string;
  address?: string;
  initiatorName?: string | null;
  initiatorEmail?: string | null;
  initiator?: AdminAuditUser | null;
  initiatedDate?: string;
  signatories?: AdminCompanySignatory[];
};

export type AdminCompanyGroup = {
  groupDetails: AdminGroupDetails | null;
  companyDetails: AdminActiveCompanyDetails[];
};

export type AdminPendingCompanyGroup = {
  groupDetails: AdminGroupDetails | null;
  companyDetails: AdminPendingCompanyDetails[];
};

export type AdminListPageInfo = {
  page: number;
  nextCursor: string | null;
  prevCursor: string | null;
  topCursor: string | null;
  hasNext: boolean;
  hasPrev: boolean;
  hasNewData: boolean;
  newCount: number;
};

export type FetchAdminGroupsResponse = {
  message: 'Companies fetched successfully!';
  data: AdminCompanyGroup[] | AdminPendingCompanyGroup[];
  activeCount: number;
  inactiveCount: number;
  pendingCount: number;
  pageInfo: AdminListPageInfo;
};

export type FetchCompanyDetailsResponse = {
  message: 'Company details fetched successfully!';
  data: {
    groupDetails: AdminGroupDetails | null;
    companyDetails: Array<{
      companyCode: string;
      name: string;
      gst: string | null;
      brand: string | null;
      ieCode: string;
      registration: string;
      address: string;
      initiator?: AdminAuditUser | null;
      initiatedDate?: string;
      signatories: AdminCompanySignatory[];
    }>;
  };
};

export type InitiateCompanyOnboardingResponse = {
  message: 'Onboarding initiated successfully';
  companyCode: string;
  groupCode: string | null;
};

export type ActionCompanyOnboardingStatus = 'APPROVED' | 'REJECTED';

export type ActionCompanyOnboardingResult = {
  message: string;
  status: ActionCompanyOnboardingStatus;
};

export type ActionCompanyOnboardingResponse = {
  message: string;
  data: ActionCompanyOnboardingResult;
};

export type AdminAuditUser = {
  name: string;
  email: string;
};

export type AdminCompanyHistoryEvent = 'INITIATE' | 'APPROVED' | 'REJECTED';

export type AdminCompanyHistoryItem = {
  companyCode: string;
  event: AdminCompanyHistoryEvent;
  createdAt: string;
  user: AdminAuditUser;
};

export type FetchCompanyHistoryInternalSuccess = {
  message: string;
  code: number;
  data: AdminCompanyHistoryItem[];
};

export type FetchCompanyHistoryResponse = {
  message: string;
  code: number;
  data: AdminCompanyHistoryItem[];
};

export type AdminBackendCompany = {
  id: string;
  companyCode: string;
  legalName: string;
  gstNumber: string | null;
  brandName: string | null;
  ieCode: string | null;
  registrationDate: string;
  address: string | null;
  status: AdminCompanyStatus;
  signatories?: AdminCompanySignatory[];
  companyMappings?: Array<{
    group: {
      groupCode: string;
      name: string;
    };
  }>;
};

export type AdminBackendCompanyDetails = {
  groupDetails: AdminGroupDetails | null;
  companyDetails: Array<{
    companyCode: string;
    name: string;
    gst: string | null;
    brand: string | null;
    ieCode: string;
    registration: string;
    address: string;
    initiator?: AdminAuditUser | null;
    initiatedDate?: string;
    signatories: AdminCompanySignatory[];
  }>;
};

export type AdminBackendCompanyMapping = {
  company: AdminBackendCompany;
};

export type AdminBackendGroup = {
  groupCode: string;
  name: string;
  status: AdminCompanyStatus;
  companyMappings: AdminBackendCompanyMapping[];
};

export type AdminPendingOnboardingData = {
  group?: {
    name?: string;
    groupCode?: string;
  } | null;
  company?: {
    name?: string;
    gst?: string;
    brand?: string;
    ieCode?: string;
    registeredAt?: string;
    address?: string;
  } | null;
  signatories?: Partial<AdminCompanySignatory>[];
};

export type AdminBackendPendingOnboarding = {
  id: string;
  companyCode: string;
  groupCode: string | null;
  data?: AdminPendingOnboardingData | null;
  createdAt: string;
  initiator?: AdminAuditUser | null;
  initiatedDate?: string;
};

export type FetchAdminGroupsInternalSuccess = {
  data: AdminBackendCompany[] | AdminBackendPendingOnboarding[];
  activeCount: number;
  inactiveCount: number;
  pendingCount: number;
  pageInfo: AdminListPageInfo;
};

export type AdminApiErrorResponse = {
  message?: string;
  error?: string;
};

export type FetchAdminGroupsInternalResponse =
  | FetchAdminGroupsInternalSuccess
  | AdminApiErrorResponse;

export type ActionCompanyOnboardingInternalResponse =
  | ActionCompanyOnboardingResult
  | AdminApiErrorResponse;

export type FetchCompanyHistoryInternalResponse =
  | FetchCompanyHistoryInternalSuccess
  | AdminCompanyHistoryItem[]
  | AdminApiErrorResponse;

export type FetchCompanyDetailsInternalResponse =
  | AdminBackendCompanyDetails
  | AdminApiErrorResponse;
