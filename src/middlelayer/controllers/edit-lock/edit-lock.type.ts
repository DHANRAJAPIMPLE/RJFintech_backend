export type EditLockType = 'USER' | 'ORG' | 'WORKFLOW';

export type EditLockResponse = {
  lockAcquired: boolean;
  locked: boolean;
  released: boolean;
  expiresAt: string | null;
  message: string;
};

export type EditLockApiErrorResponse = {
  error?: string;
  message?: string;
};

export type EditLockInternalResponse =
  | EditLockResponse
  | EditLockApiErrorResponse
  | null;
