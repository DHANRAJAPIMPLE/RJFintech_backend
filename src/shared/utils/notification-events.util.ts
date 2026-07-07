import { EventEmitter } from 'node:events';

export type NotificationEventPayload = {
  userId: string;
  companyId: string;
  notification: Record<string, unknown>;
};

const notificationEmitter = new EventEmitter();
notificationEmitter.setMaxListeners(0);

export const emitNotificationEvent = (payload: NotificationEventPayload) => {
  notificationEmitter.emit('notification', payload);
};

export const onNotificationEvent = (
  listener: (payload: NotificationEventPayload) => void,
) => {
  notificationEmitter.on('notification', listener);
  return () => notificationEmitter.off('notification', listener);
};
