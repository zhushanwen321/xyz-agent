import type { SystemNotification } from '../stores/chat'

export type SystemNotificationType = 'done' | 'alert' | 'info'

export function createSystemNotification(
  type: SystemNotificationType,
  title: string,
  description?: string,
  action?: string,
): SystemNotification {
  return {
    id: crypto.randomUUID(),
    role: 'system',
    notificationType: type,
    notificationTitle: title,
    notificationDescription: description,
    notificationAction: action,
    timestamp: Date.now(),
  }
}
