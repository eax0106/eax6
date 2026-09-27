import { randomUUID } from "node:crypto";

import type {
  ConversationDispatchHandler,
  IncomingConversationMessage,
} from "@alterx/adapters";

import type { DispatchableInboundMessage } from "./whatsapp-webhook.service";

interface OrchestrationTransactionLike {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rowCount: number; readonly rows: readonly TRow[] }>;
}

export interface OrchestrationTenantStore {
  withTenant<T>(
    tenantId: string,
    operation: (tx: OrchestrationTransactionLike) => Promise<T>,
  ): Promise<T>;
}

export interface ConversationDispatchServiceConfig {
  readonly taskQueue: string;
  readonly idleTimeoutSeconds: number;
  readonly historyRolloverEventCount: number;
}

type ConversationChannel = IncomingConversationMessage["channel"];

interface ResolvedConversation {
  readonly conversationId: string;
  readonly temporalWorkflowId: string;
}

const CONVERSATION_LIFECYCLE_WORKFLOW_TYPE = "conversationLifecycleWorkflow";

function prefixedUuidV7(prefix: "conv" | "convwf"): string {
  const uuid = randomUUID();
  return `${prefix}_${uuid.slice(0, 14)}7${uuid.slice(15)}`;
}

export class ConversationDispatchService {
  constructor(
    private readonly store: OrchestrationTenantStore,
    private readonly dispatchClient: ConversationDispatchHandler,
    private readonly config: ConversationDispatchServiceConfig,
  ) {}

  // At-least-once dispatch: this is called for every inbound message in a
  // webhook delivery regardless of whether the underlying event row was
  // newly persisted or a duplicate (see DispatchableInboundMessage's own
  // doc comment). Safe to call more than once for the same message because
  // Temporal's signal-with-start plus conversationLifecycleWorkflow's own
  // messageId dedup make re-dispatch a no-op.
  async dispatchInboundMessages(
    tenantId: string,
    workspaceId: string,
    channel: ConversationChannel,
    messages: readonly DispatchableInboundMessage[],
  ): Promise<void> {
    for (const inbound of messages) {
      const resolved = await this.resolveConversation(
        tenantId,
        workspaceId,
        channel,
        inbound,
      );

      const signalPayload: IncomingConversationMessage = {
        messageId: inbound.idempotencyKey,
        channel,
        // Already-parsed JSON from a verified webhook body -- genuinely
        // JsonValue-shaped at runtime, just not provable from the
        // Record<string, unknown> type it arrives as.
        payload: inbound.payload as IncomingConversationMessage["payload"],
        receivedAt: inbound.occurredAt,
      };

      await this.dispatchClient.dispatchMessage({
        workflowId: resolved.temporalWorkflowId,
        workflowType: CONVERSATION_LIFECYCLE_WORKFLOW_TYPE,
        workflowInput: {
          tenantId,
          conversationId: resolved.conversationId,
          idleTimeoutSeconds: this.config.idleTimeoutSeconds,
          historyRolloverEventCount: this.config.historyRolloverEventCount,
        },
        signalName: "message",
        signalPayload: { ...signalPayload },
      });
    }
  }

  // Correlation-ID routing: finds the most recent still-open conversation
  // for this subject (e.g. WhatsApp phone number) on this channel, or
  // creates a new one. There is no phone-number/external-id column on
  // `conversations` itself (see INGR-6's disclosed single-tenant-per-
  // deployment gap) -- routing goes through the most recent matching
  // `events` row instead, which already carries `subject_id`.
  private async resolveConversation(
    tenantId: string,
    workspaceId: string,
    channel: ConversationChannel,
    inbound: DispatchableInboundMessage,
  ): Promise<ResolvedConversation> {
    return this.store.withTenant(tenantId, async (tx) => {
      const existing = await tx.query<{
        id: string;
        temporal_workflow_id: string;
      }>(
        `SELECT c.id, c.temporal_workflow_id
         FROM conversations c
         JOIN events e ON e.tenant_id = c.tenant_id AND e.conversation_id = c.id
         WHERE c.tenant_id = $1 AND c.workspace_id = $2 AND c.channel = $3
           AND e.subject_id = $4
           AND c.status NOT IN ('closed', 'archived')
         ORDER BY e.occurred_at DESC
         LIMIT 1`,
        [tenantId, workspaceId, channel, inbound.subjectId],
      );

      const row = existing.rows[0];
      const resolved: ResolvedConversation =
        row === undefined
          ? await this.createConversation(tx, tenantId, workspaceId, channel)
          : { conversationId: row.id, temporalWorkflowId: row.temporal_workflow_id };

      await tx.query(
        `UPDATE events SET conversation_id = $1, correlation_id = $1
         WHERE tenant_id = $2 AND idempotency_key = $3 AND conversation_id IS NULL`,
        [resolved.conversationId, tenantId, inbound.idempotencyKey],
      );

      return resolved;
    });
  }

  private async createConversation(
    tx: OrchestrationTransactionLike,
    tenantId: string,
    workspaceId: string,
    channel: ConversationChannel,
  ): Promise<ResolvedConversation> {
    const conversationId = prefixedUuidV7("conv");
    const temporalWorkflowId = prefixedUuidV7("convwf");

    await tx.query(
      `INSERT INTO conversations (
         id, tenant_id, workspace_id, channel, temporal_workflow_id,
         status, idle_timeout_seconds
       ) VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
      [
        conversationId,
        tenantId,
        workspaceId,
        channel,
        temporalWorkflowId,
        this.config.idleTimeoutSeconds,
      ],
    );

    return { conversationId, temporalWorkflowId };
  }
}
