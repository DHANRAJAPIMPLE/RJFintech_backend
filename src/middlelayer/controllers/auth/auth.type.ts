export type AuthCompany = {
  legalName: string;
  brandName: string;
  companyCode: string;
};

export type AuthUserGroup = {
  groupName: string;
  groupCode: string;
  companies: AuthCompany[];
};

export type AuthUserProfile = {
  name: string;
  email: string;
  phone: string;
  groups: AuthUserGroup[];
};

export type AuthMeResponse = {
  user: AuthUserProfile;
};

export type AuthLoginResponse = {
  message: 'Login successful';
  user: AuthUserProfile;
};

export type AuthForceLoginResponse = {
  message: 'User already logged in another device';
  status: 1;
  forceLogToken: string;
};

export type AuthLoginApiResponse = AuthLoginResponse | AuthForceLoginResponse;

export type AuthLogoutResponse = {
  message: 'Logged out successfully';
};

export type AuthAccessRightsRequest = {
  email: string;
  companyCode: string;
};

export type AuthAccessRoleCategory =
  | 'ALL'
  | 'TRANSACTIONAL'
  | 'OPERATIONAL'
  | 'SYSTEM_ACCESS'
  | 'SAAS_ADMIN';

export type AuthAccessRoleSubCategory =
  | 'ALL'
  | 'ACCOUNTS'
  | 'PAYMENTS'
  | 'PURCHASE'
  | 'FIN_OPS'
  | 'MASTER'
  | 'ORG_STR'
  | 'USER_ACC'
  | 'WORK_FLOW'
  | 'SAAS_ADMIN';

export type AuthAccessNodeType =
  | 'ROOT'
  | 'DIVISION'
  | 'DEPARTMENT'
  | 'TEAM'
  | 'PLANT'
  | 'LOCATION';

export type AuthAccessCategory = 'ALL_CHILD' | 'IMMEDIATE_CHILD' | 'NODE';

export type AuthAccessRight = {
  roleCategory: AuthAccessRoleCategory;
  roleSubCategory: AuthAccessRoleSubCategory;
  roleName: string;
  nodeName: string;
  nodePath: string;
  nodeType: AuthAccessNodeType;
  accessCategory: AuthAccessCategory;
};

export type AuthAccessRightsResponse = {
  primary: AuthAccessRight[];
  secondary: AuthAccessRight[];
};

export type AuthApiErrorResponse = {
  message?: string;
  error?: string;
};

export type AuthBackendGroup = {
  name: string;
  groupCode: string;
};

export type AuthBackendCompanyMapping = {
  group: AuthBackendGroup | null;
};

export type AuthBackendCompany = AuthCompany & {
  companyMappings: AuthBackendCompanyMapping[];
};

export type AuthBackendUserMapping = {
  companyId: string;
  company: AuthBackendCompany;
};

export type AuthBackendUser = {
  id: string;
  name: string;
  email: string;
  phone: string;
  password?: string;
  userMappings: AuthBackendUserMapping[];
};

export type AuthBackendLoginUser = AuthBackendUser & {
  password: string;
};
