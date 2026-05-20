export type RoleCategory =
  | 'ALL'
  | 'TRANSACTIONAL'
  | 'OPERATIONAL'
  | 'SYSTEM_ACCESS';

export type RoleSubCategory =
  | 'ALL'
  | 'ACCOUNTS'
  | 'PAYMENTS'
  | 'PURCHASE'
  | 'FIN_OPS'
  | 'MASTER'
  | 'ORG_STR'
  | 'USER_ACC'
  | 'WORK_FLOW';

export type RolePermissionLevel = 'ALL' | 'VIEWER' | 'USER' | 'MANAGER';

export type FetchAllRolesItem = {
  roleName: string;
  category: RoleCategory;
  subCategory: RoleSubCategory;
  permissionLevel: RolePermissionLevel;
};

export type FetchAllRolesResponse = {
  success: true;
  data: FetchAllRolesItem[];
};

export type RoleApiErrorResponse = {
  message?: string;
  error?: string;
};

export type FetchAllRolesInternalResponse =
  | FetchAllRolesItem[]
  | RoleApiErrorResponse;
