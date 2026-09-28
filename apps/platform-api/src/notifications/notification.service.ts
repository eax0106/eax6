import { randomBytes } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { EmailProvider } from "@alterx/shared-clients";
import { NotificationHttpError } from "./problem";
import { NotificationRepository } from "./notification.repository";
import { SystemNotificationStore } from "./system-notification-store";
import { EMAIL_PROVIDER } from "./tokens";
import type {
  CreateNotificationEventInput,
  DigestWindow,
  NotificationChannel,
  NotificationEvent,
  NotificationEventClass,
  NotificationListInput,
  NotificationPage,
  NotificationPreference,
} from "./types";

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly repository: NotificationRepository,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    private readonly systemStore?: SystemNotificationStore,
  ) {}

  async createEvent(input: CreateNotificationEventInput): Promise<NotificationEvent> {
    const [inAppEnabled, emailPreference] = await Promise.all([
      this.repository.preferenceEnabled(input.tenantId, input.userId, input.eventClass, "in_app"),
      this.repository.emailDeliveryPreference(input.tenantId, input.userId, input.eventClass),
    ]);
    const event = await this.repository.createEvent(createEventId(), input, inAppEnabled);
    // Only 'immediate' mode sends here -- 'digest' mode accumulates and is
    // sent once by buildDigest/runDueDigests, never both (real, previously
    // found double-send gap, closed by the delivery_mode column).
    if (emailPreference.enabled && emailPreference.deliveryMode === "immediate") {
      await this.sendEventEmail(event, input.userId, input.locale);
    }
    return event;
  }

  /**
   * One event per member holding any of `roles` in the workspace, each
   * delivered by that member's own preferences. Returns how many were created.
   */
  async notifyWorkspaceRoles(
    roles: readonly string[],
    input: Omit<CreateNotificationEventInput, "userId">,
  ): Promise<number> {
    const recipients = await this.repository.workspaceMemberIds(input.tenantId, input.workspaceId, roles);
    for (const userId of recipients) {
      await this.createEvent({ ...input, userId });
    }
    return recipients.length;
  }

  list(input: NotificationListInput): Promise<NotificationPage> {
    return this.repository.list(input);
  }

  async markRead(tenantId: string, userId: string, eventId: string): Promise<void> {
    if (!(await this.repository.markRead(tenantId, userId, eventId))) {
      throw notFound(`/api/v1/notifications/${encodeURIComponent(eventId)}/actions/read`);
    }
  }

  async acknowledge(tenantId: string, userId: string, eventId: string): Promise<void> {
    if (!(await this.repository.acknowledge(tenantId, userId, eventId))) {
      throw notFound(`/api/v1/notifications/${encodeURIComponent(eventId)}/actions/acknowledge`);
    }
  }

  listPreferences(tenantId: string, userId: string): Promise<NotificationPreference[]> {
    return this.repository.listPreferences(tenantId, userId);
  }

  updatePreference(
    tenantId: string,
    userId: string,
    eventClass: NotificationEventClass,
    channel: NotificationChannel,
    enabled: boolean,
    deliveryMode?: NotificationPreference["deliveryMode"],
  ): Promise<NotificationPreference> {
    return this.repository.upsertPreference(
      tenantId,
      userId,
      eventClass,
      channel,
      enabled,
      deliveryMode,
    );
  }

  async buildDigest(window: DigestWindow): Promise<{ readonly eventCount: number; readonly sent: boolean }> {
    if (window.periodStart >= window.periodEnd) {
      throw new Error("Digest period start must be before period end");
    }
    // listDigestCandidates already real-filters to enabled, delivery_mode
    // = 'digest' rows at the SQL layer -- no further JS-side filtering
    // needed.
    const candidates = await this.repository.listDigestCandidates(window);
    if (candidates.length === 0) return { eventCount: 0, sent: false };

    const digestId = await this.repository.reserveDigest(
      window,
      candidates.map((event) => event.id),
    );
    if (!digestId) return { eventCount: candidates.length, sent: false };

    try {
      await this.email.sendTemplatedEmail(
        candidates[0]!.email,
        "notification-digest",
        {
          period_start: window.periodStart.toISOString(),
          period_end: window.periodEnd.toISOString(),
          event_count: String(candidates.length),
          events: JSON.stringify(candidates.map(digestEvent)),
        },
      );
      await this.repository.markDigestSent(window.tenantId, digestId);
      return { eventCount: candidates.length, sent: true };
    } catch (error) {
      await this.repository.releaseDigest(window.tenantId, digestId);
      throw error;
    }
  }

  /**
   * Real digest-cycle orchestration: enumerate every real (tenant, user)
   * pair with a due digest window via the bypass-RLS system store, then
   * build each real digest through the same real buildDigest path used
   * everywhere else -- no separate/duplicated digest-sending logic here.
   * One user's failure is isolated and doesn't block the others.
   */
  async runDueDigests(
    periodStart: Date,
    periodEnd: Date,
  ): Promise<{ readonly usersProcessed: number; readonly usersFailed: number }> {
    if (!this.systemStore) {
      throw new NotificationHttpError(
        503,
        "NOTIFICATION_DIGEST_SCHEDULER_NOT_CONFIGURED",
        "Digest scheduling requires the platform_db bypass-RLS system store, which is not configured",
        "/internal/notifications/run-due-digests",
      );
    }
    const eligible = await this.systemStore.listUsersDueForDigest(periodStart, periodEnd);
    let usersFailed = 0;
    for (const user of eligible) {
      try {
        await this.buildDigest({
          tenantId: user.tenantId,
          userId: user.userId,
          periodStart,
          periodEnd,
        });
      } catch (error) {
        usersFailed += 1;
        this.logger.error({
          tenantId: user.tenantId,
          userId: user.userId,
          message: "digest build failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { usersProcessed: eligible.length, usersFailed };
  }

  private async sendEventEmail(
    event: NotificationEvent,
    userId: string,
    locale: string | undefined,
  ): Promise<void> {
    const email = await this.repository.findUserEmail(event.tenantId, userId);
    if (!email) {
      this.logger.warn({ eventId: event.id, message: "notification recipient has no email" });
      return;
    }
    try {
      await this.email.sendTemplatedEmail(
        email,
        `notification-${event.eventClass}`,
        {
          title: event.title,
          body: event.body,
          severity: event.severity,
          deep_link: event.deepLink ?? "",
        },
        locale,
      );
    } catch {
      this.logger.error({ eventId: event.id, message: "notification email delivery failed" });
    }
  }
}

function createEventId(): string {
  const bytes = randomBytes(16);
  const timestamp = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number((timestamp >> BigInt((5 - index) * 8)) & 0xffn);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `evt_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function digestEvent(event: {
  readonly id: string;
  readonly event_class: string;
  readonly severity: string;
  readonly title: string;
  readonly body: string;
  readonly deep_link: string | null;
  readonly created_at: Date;
}): Record<string, string> {
  return {
    id: event.id,
    event_class: event.event_class,
    severity: event.severity,
    title: event.title,
    body: event.body,
    deep_link: event.deep_link ?? "",
    created_at: event.created_at.toISOString(),
  };
}

function notFound(instance: string): NotificationHttpError {
  return new NotificationHttpError(404, "NOTIFICATION_NOT_FOUND", "Notification was not found", instance);
}
