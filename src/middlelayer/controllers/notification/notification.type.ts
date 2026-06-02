export type NotificationActionType =
  | 'INITIATE'
  | 'APPROVE'
  | 'REJECT'
  | 'ONBOARDED'
  | 'MODIFICATION'
  | 'ACTIVE'
  | 'INACTIVE'
  | 'ARCHIVE';

export type NotificationReferenceType = 'USER' | 'ORG' | 'WORKFLOW' | 'COMPANY';

export type NotificationFetchDateRange =
  | 'ALL'
  | '7_DAYS'
  | '15_DAYS'
  | '1_MONTH'
  | 'CUSTOM';

export type NotificationUserStatus = 'READ' | 'UNREAD' | 'ARCHIVED';

export type NotificationFetchStatus = 'READ' | 'UNREAD' | 'ALL';

export type NotificationFetchRequest = {
  status?: NotificationFetchStatus;
  referenceType?: NotificationReferenceType;
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
  status: NotificationUserStatus;
  createdByname: string | null;
  createdByemail: string | null;
  createat_timestamp: string;
};

export type FetchNotificationsResponse = {
  data: NotificationFetchItem[];
  count: number;
  limit: number;
  offset: number;
  status: NotificationFetchStatus;
  cursorId: string | null;
  nextCursorId: string | null;
  hasNextPage: boolean;
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
