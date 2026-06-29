export type NotificationActionType =
  | 'INITIATE'
  | 'MODIFICATION'
  | 'ACTIVE'
  | 'INACTIVE'
  | 'ARCHIVE'
  | 'PENDING APPROVAL'
  | 'PENDING APPROVAL - ACTIVATION'
  | 'Pending Approval - INITIATE'
  | 'Pending Approval - MODIFICATION'
  | 'Pending Approval - ACTIVE'
  | 'Pending Approval - INACTIVE'
  | 'Pending Approval - ARCHIVED'
  | 'APPROVED'
  | 'ONBOARDED'
  | 'Modified'
  | 'MODIFIED'
  | 'ACTIVATED'
  | 'INACTIVED'
  | 'INACTIVATED'
  | 'ARCHIVED'
  | 'REJECTED'
  | 'REJECTED-INITIATE'
  | 'REJECTED-MODIFICATION'
  | 'REJECTED-ACTIVE'
  | 'REJECTED-INACTIVE'
  | 'REJECTED-ARCHIVED'
  | 'FAILED'
  | 'AUTO_DELETE';

export type NotificationReferenceType = 'USER' | 'ORG' | 'WORKFLOW' | 'COMPANY';
export type NotificationReferenceTypeFilter =
  | NotificationReferenceType
  | NotificationReferenceType[]
  | null;

export type NotificationFetchDateRange =
  | 'ALL'
  | '7_DAYS'
  | '15_DAYS'
  | '1_MONTH'
  | 'CUSTOM';

export type NotificationUserStatus = 'READ' | 'UNREAD' | 'ARCHIVED' | 'HIDDEN';

export type NotificationFetchStatus =
  | 'READ'
  | 'UNREAD'
  | 'HIDDEN'
  | 'ALL';
export type NotificationFetchStatusFilter =
  | NotificationFetchStatus
  | NotificationFetchStatus[];

export type NotificationFetchRequest = {
  status?: NotificationFetchStatusFilter;
  refType?: NotificationReferenceTypeFilter;
  module?: NotificationReferenceTypeFilter;
  type?: string | string[];
  filters?: {
    status?: NotificationFetchStatusFilter;
    refType?: NotificationReferenceTypeFilter;
    module?: NotificationReferenceTypeFilter;
    type?: string | string[];
  };
  dateRange?: NotificationFetchDateRange;
  fromDate?: string;
  toDate?: string;
  cursorId?: string | null;
  cursor?: string | null;
  offset?: number;
  limit?: number;
};

export type NotificationFetchItem = {
  id: string;
  name: string;
  message: string;
  type: NotificationActionType;
  refType: NotificationReferenceType | null;
  referenceId: string | null;
  target: string | null;
  isPending: boolean;
  status: NotificationUserStatus;
  createdByname: string | null;
  createdByemail: string | null;
  createat_timestamp: string;
};

export type NotificationFilterOption = {
  label: string;
  value: string;
  count: number;
};

export type FetchNotificationsResponse = {
  data: NotificationFetchItem[];
  count: number;
  unreadCount: number;
  allCount: number;
  hiddenCount: number;
  limit: number;
  offset: number;
  status: NotificationFetchStatus;
  cursorId: string | null;
  nextCursorId: string | null;
  hasNextPage: boolean;
  filters: {
    status: NotificationFilterOption[];
    module: NotificationFilterOption[];
    type: NotificationFilterOption[];
  };
};

export type NotificationApiErrorResponse = {
  message?: string;
  error?: string;
};

export type FetchNotificationsInternalResponse =
  | FetchNotificationsResponse
  | NotificationApiErrorResponse;

export type MarkNotificationReadRequest = {
  notificationUserId?: string;
  notificationId?: string;
  id?: string;
  status?: NotificationUserStatus;
};

export type MarkNotificationReadResponse = {
  message: 'Notification status updated';
};

export type MarkNotificationReadInternalResponse =
  | MarkNotificationReadResponse
  | NotificationApiErrorResponse;

export type NotificationSseConnectedEvent = {
  ok: true;
};

export type NotificationSseHeartbeatEvent = {
  at: string;
};

export type NotificationSseNotificationEvent = NotificationFetchItem;

export type NotificationSseEventPayloadMap = {
  connected: NotificationSseConnectedEvent;
  heartbeat: NotificationSseHeartbeatEvent;
  notification: NotificationSseNotificationEvent;
};

export type NotificationSseEventName = keyof NotificationSseEventPayloadMap;

export type NotificationSettingsModule =
  | 'USER'
  | 'WORKFLOW'
  | 'ORG'
  | 'COMPANY';

export type FetchNotificationSettingsResponse = {
  success: true;
  data: Array<{
    companyName: string | null;
    companyCode: string;
    nodes: Array<{
      nodePath: string;
      nodeName: string;
      nodeType: string;
      levelCount: number;
      settings: Array<{
        module: NotificationSettingsModule;
        isEnabled: boolean;
      }>;
    }>;
  }>;
};

export type UpdateNotificationSettingsRequest = Array<{
  companyCode: string;
  settings: Array<{
    nodePath: string;
    module: NotificationSettingsModule;
    isEnabled: boolean;
    remarks?: string | null;
  }>;
}>;

export type UpdateNotificationSettingsResponse = {
  success: true;
  message: string;
  data: Array<{
    companyCode: string;
    nodePath: string;
    nodeName: string;
    module: NotificationSettingsModule;
    isEnabled: boolean;
  }>;
};
