import { randomUUID } from "node:crypto";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import type {
  CreateNotificationEventInput,
  DigestWindow,
  NotificationChannel,
  NotificationDeliveryMode,
  NotificationEvent,
  NotificationEventClass,
  NotificationListInput,
  NotificationPage,
  NotificationPreference,
  NotificationSeverity,
} from "./types";

interface EventRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  event_class: NotificationEventClass;
  severity: NotificationSeverity;
  title: string;
  body: string;
  deep_link: string | null;
  created_at: Date;
  source_service: string;
  read_at: Date | null;
  acknowledged_at: Date | null;
}

interface PreferenceRow {
  event_class: NotificationEventClass;
  channel: NotificationChannel;
  enabled: boolean;
  delivery_mode: NotificationDeliveryMode;
}

interface DigestCandidateRow extends EventRow {
  email: string;
}

@Injectable()
export class NotificationRepository implements OnModuleDestroy {
  constructor(
    private readonly pool: Pool,
    private readonly closePoolOnDestroy = false,
  ) {}

  createEvent(
    id: string,
    input: CreateNotificationEventInput,
    inAppEnabled: boolean,
  ): Promise<NotificationEvent> {
    return this.withTenant(input.tenantId, async (client) => {
      const event = await client.query<EventRow>(
        `INSERT INTO notification_events
           (id, tenant_id, workspace_id, event_class, severity, title, body,
            deep_link, source_service)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, tenant_id, workspace_id, event_class, severity, title, body,
                   deep_link, created_at, source_service, NULL::timestamptz AS read_at,
                   NULL::timestamptz AS acknowledged_at`,
        [
          id,
          input.tenantId,
          input.workspaceId,
          input.eventClass,
          input.severity,
          input.title,
          input.body,
          input.deepLink,
          input.sourceService,
        ],
      );
      await client.query(
        `INSERT INTO notification_reads
           (id, tenant_id, notification_event_id, user_id, in_app_enabled)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), input.tenantId, id, input.userId, inAppEnabled],
      );
      return mapEvent(event.rows[0]!);
    });
  }

  async list(input: NotificationListInput): Promise<NotificationPage> {
    return this.withTenant(input.tenantId, async (client) => {
      const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
      const result = await client.query<EventRow>(
        `SELECT e.id, e.tenant_id, e.workspace_id, e.event_class, e.severity,
                e.title, e.body, e.deep_link, e.created_at, e.source_service,
                r.read_at, r.acknowledged_at
           FROM notification_events e
           JOIN notification_reads r
             ON r.tenant_id = e.tenant_id AND r.notification_event_id = e.id
          WHERE e.tenant_id = $1 AND r.user_id = $2 AND r.in_app_enabled = true
            AND ($3::boolean IS NULL OR (r.read_at IS NOT NULL) = $3)
            AND ($4::text IS NULL OR e.severity = $4)
            AND ($5::text IS NULL OR e.event_class = $5)
            AND ($6::timestamptz IS NULL OR (e.created_at, e.id) < ($6, $7))
          ORDER BY e.created_at DESC, e.id DESC
          LIMIT $8`,
        [
          input.tenantId,
          input.userId,
          input.read ?? null,
          input.severity ?? null,
          input.eventClass ?? null,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          input.limit + 1,
        ],
      );
      const rows = result.rows.slice(0, input.limit);
      const tail = rows.at(-1);
      return {
        items: rows.map(mapEvent),
        nextCursor:
          result.rows.length > input.limit && tail
            ? encodeCursor(tail.created_at, tail.id)
            : null,
      };
    });
  }

  async markRead(tenantId: string, userId: string, eventId: string): Promise<boolean> {
    return this.updateReadState(
      tenantId,
      userId,
      eventId,
      "read_at = COALESCE(read_at, clock_timestamp())",
    );
  }

  async acknowledge(tenantId: string, userId: string, eventId: string): Promise<boolean> {
    return this.updateReadState(
      tenantId,
      userId,
      eventId,
      `read_at = COALESCE(read_at, clock_timestamp()),
       acknowledged_at = COALESCE(acknowledged_at, clock_timestamp())`,
    );
  }

  /** The users holding any of `roles` in one workspace: a producer's recipients. */
  workspaceMemberIds(
    tenantId: string,
    workspaceId: string,
    roles: readonly string[],
  ): Promise<string[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<{ user_id: string }>(
        `SELECT user_id FROM workspace_members
          WHERE tenant_id = $1 AND workspace_id = $2 AND role = ANY($3::text[])
          ORDER BY user_id`,
        [tenantId, workspaceId, [...roles]],
      );
      return result.rows.map((row) => row.user_id);
    });
  }

  listPreferences(tenantId: string, userId: string): Promise<NotificationPreference[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<PreferenceRow>(
        `SELECT event_class, channel, enabled, delivery_mode FROM notification_preferences
          WHERE tenant_id = $1 AND user_id = $2
          ORDER BY event_class, channel`,
        [tenantId, userId],
      );
      return result.rows.map((row) => ({
        eventClass: row.event_class,
        channel: row.channel,
        enabled: row.enabled,
        deliveryMode: row.delivery_mode,
      }));
    });
  }

  async preferenceEnabled(
    tenantId: string,
    userId: string,
    eventClass: NotificationEventClass,
    channel: NotificationChannel,
  ): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<{ enabled: boolean }>(
        `SELECT enabled FROM notification_preferences
          WHERE tenant_id = $1 AND user_id = $2 AND event_class = $3 AND channel = $4`,
        [tenantId, userId, eventClass, channel],
      );
      return result.rows[0]?.enabled ?? true;
    });
  }

  /**
   * Email-channel enabled + delivery mode together -- immediate-send
   * (createEvent) must only fire for delivery_mode='immediate' rows, so
   * digest-mode events aren't double-sent (once immediately, once in the
   * digest batch).
   */
  async emailDeliveryPreference(
    tenantId: string,
    userId: string,
    eventClass: NotificationEventClass,
  ): Promise<{ readonly enabled: boolean; readonly deliveryMode: NotificationDeliveryMode }> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<{ enabled: boolean; delivery_mode: NotificationDeliveryMode }>(
        `SELECT enabled, delivery_mode FROM notification_preferences
          WHERE tenant_id = $1 AND user_id = $2 AND event_class = $3 AND channel = 'email'`,
        [tenantId, userId, eventClass],
      );
      const row = result.rows[0];
      return { enabled: row?.enabled ?? true, deliveryMode: row?.delivery_mode ?? "immediate" };
    });
  }

  upsertPreference(
    tenantId: string,
    userId: string,
    eventClass: NotificationEventClass,
    channel: NotificationChannel,
    enabled: boolean,
    deliveryMode: NotificationDeliveryMode = "immediate",
  ): Promise<NotificationPreference> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<PreferenceRow>(
        `INSERT INTO notification_preferences
           (id, tenant_id, user_id, event_class, channel, enabled, delivery_mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, user_id, event_class, channel) DO UPDATE
           SET enabled = EXCLUDED.enabled, delivery_mode = EXCLUDED.delivery_mode
         RETURNING event_class, channel, enabled, delivery_mode`,
        [randomUUID(), tenantId, userId, eventClass, channel, enabled, deliveryMode],
      );
      const row = result.rows[0]!;
      return {
        eventClass: row.event_class,
        channel: row.channel,
        enabled: row.enabled,
        deliveryMode: row.delivery_mode,
      };
    });
  }

  findUserEmail(tenantId: string, userId: string): Promise<string | undefined> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<{ email: string }>(
        `SELECT u.email
           FROM users u
           JOIN tenant_members tm ON tm.user_id = u.id
          WHERE tm.tenant_id = $1 AND tm.user_id = $2`,
        [tenantId, userId],
      );
      return result.rows[0]?.email;
    });
  }

  /**
   * Only real delivery_mode='digest' preferences qualify -- 'immediate'
   * rows already got emailed synchronously in createEvent(), including
   * them here would double-send the same event.
   */
  listDigestCandidates(window: DigestWindow): Promise<DigestCandidateRow[]> {
    return this.withTenant(window.tenantId, async (client) => {
      const result = await client.query<DigestCandidateRow>(
        `SELECT e.id, e.tenant_id, e.workspace_id, e.event_class, e.severity,
                e.title, e.body, e.deep_link, e.created_at, e.source_service,
                r.read_at, r.acknowledged_at, u.email
           FROM notification_events e
           JOIN notification_reads r
             ON r.tenant_id = e.tenant_id AND r.notification_event_id = e.id
           JOIN users u ON u.id = r.user_id
           JOIN notification_preferences p
             ON p.tenant_id = e.tenant_id AND p.user_id = r.user_id
                AND p.event_class = e.event_class AND p.channel = 'email'
                AND p.delivery_mode = 'digest' AND p.enabled = true
          WHERE e.tenant_id = $1 AND r.user_id = $2
            AND e.created_at >= $3 AND e.created_at < $4
            AND NOT EXISTS (
              SELECT 1 FROM notification_digests d
               WHERE d.tenant_id = e.tenant_id AND d.user_id = r.user_id
                 AND d.sent_at IS NOT NULL
                 AND d.event_ids_json @> jsonb_build_array(e.id)
            )
          ORDER BY e.created_at ASC, e.id ASC`,
        [window.tenantId, window.userId, window.periodStart, window.periodEnd],
      );
      return result.rows;
    });
  }

  async reserveDigest(window: DigestWindow, eventIds: readonly string[]): Promise<string | undefined> {
    return this.withTenant(window.tenantId, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO notification_digests
           (id, tenant_id, user_id, period_start, period_end, event_ids_json, delivery_started_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, clock_timestamp())
         ON CONFLICT (tenant_id, user_id, period_start, period_end) DO UPDATE
           SET event_ids_json = EXCLUDED.event_ids_json,
               delivery_started_at = clock_timestamp()
         WHERE notification_digests.sent_at IS NULL
           AND notification_digests.delivery_started_at IS NULL
         RETURNING id`,
        [
          randomUUID(),
          window.tenantId,
          window.userId,
          window.periodStart,
          window.periodEnd,
          JSON.stringify(eventIds),
        ],
      );
      return result.rows[0]?.id;
    });
  }

  markDigestSent(tenantId: string, digestId: string): Promise<void> {
    return this.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE notification_digests
            SET sent_at = clock_timestamp(), delivery_started_at = NULL
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, digestId],
      );
    });
  }

  releaseDigest(tenantId: string, digestId: string): Promise<void> {
    return this.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE notification_digests SET delivery_started_at = NULL
          WHERE tenant_id = $1 AND id = $2 AND sent_at IS NULL`,
        [tenantId, digestId],
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.closePoolOnDestroy) await this.pool.end();
  }

  private async updateReadState(
    tenantId: string,
    userId: string,
    eventId: string,
    update: string,
  ): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE notification_reads SET ${update}
          WHERE tenant_id = $1 AND user_id = $2 AND notification_event_id = $3
            AND in_app_enabled = true`,
        [tenantId, userId, eventId],
      );
      return result.rowCount === 1;
    });
  }

  private async withTenant<T>(
    tenantId: string,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function mapEvent(row: EventRow): NotificationEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    eventClass: row.event_class,
    severity: row.severity,
    title: row.title,
    body: row.body,
    deepLink: row.deep_link,
    createdAt: row.created_at.toISOString(),
    sourceService: row.source_service,
    readAt: row.read_at?.toISOString() ?? null,
    acknowledgedAt: row.acknowledged_at?.toISOString() ?? null,
  };
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id })).toString("base64url");
}

function decodeCursor(cursor: string): { readonly createdAt: string; readonly id: string } {
  const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
  const record = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const createdAt = record?.createdAt;
  const id = record?.id;
  if (
    typeof createdAt !== "string" ||
    typeof id !== "string" ||
    Number.isNaN(Date.parse(createdAt))
  ) {
    throw new Error("Invalid notification cursor");
  }
  return { createdAt, id };
}
