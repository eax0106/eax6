export const notificationEventClasses = [
  "workflow",
  "project",
  "deployment",
  "approval",
  "budget",
  "system",
] as const;
export type NotificationEventClass = (typeof notificationEventClasses)[number];

export const notificationSeverities = ["info", "warning", "critical"] as const;
export type NotificationSeverity = (typeof notificationSeverities)[number];

export const notificationChannels = ["in_app", "email"] as const;
export type NotificationChannel = (typeof notificationChannels)[number];

export const notificationDeliveryModes = ["immediate", "digest"] as const;
export type NotificationDeliveryMode = (typeof notificationDeliveryModes)[number];

export interface CreateNotificationEventInput {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly eventClass: NotificationEventClass;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly body: string;
  readonly deepLink: string | null;
  readonly sourceService: string;
  readonly locale?: string;
  /**
   * When set, the database keeps one event per (tenant, key): a producer that
   * meets the same happening again gets `null` back and sends nothing.
   */
  readonly dedupeKey?: string;
}

export interface NotificationEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly eventClass: NotificationEventClass;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly body: string;
  readonly deepLink: string | null;
  readonly createdAt: string;
  readonly sourceService: string;
  readonly readAt: string | null;
  readonly acknowledgedAt: string | null;
}

export interface NotificationPreference {
  readonly eventClass: NotificationEventClass;
  readonly channel: NotificationChannel;
  readonly enabled: boolean;
  readonly deliveryMode: NotificationDeliveryMode;
}

export interface DigestEligibleUser {
  readonly tenantId: string;
  readonly userId: string;
}

export interface NotificationPage {
  readonly items: readonly NotificationEvent[];
  readonly nextCursor: string | null;
}

export interface NotificationListInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly read?: boolean | undefined;
  readonly severity?: NotificationSeverity | undefined;
  readonly eventClass?: NotificationEventClass | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface DigestWindow {
  readonly tenantId: string;
  readonly userId: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
}
