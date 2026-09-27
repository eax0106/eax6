import { describe, expect, it } from "vitest";

import type { ConversationDispatchHandler } from "@alterx/adapters";

import {
  ConversationDispatchService,
  type OrchestrationTenantStore,
} from "./conversation-dispatch.service";
import type { DispatchableInboundMessage } from "./whatsapp-webhook.service";

interface ConversationRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  channel: string;
  status: string;
  temporal_workflow_id: string;
}

interface EventRow {
  tenant_id: string;
  idempotency_key: string;
  subject_id: string;
  conversation_id: string | null;
  correlation_id: string | null;
}

// Mirrors reality: by the time ConversationDispatchService runs, INGR-6
// has already persisted an `events` row for every inbound message in this
// delivery (that's the whole point of dispatching from
// ProcessWebhookResult.messages). Tests seed that pre-existing row rather
// than letting the fake invent one, so an ordering bug in the real service
// (looking up a message before its event row exists) would fail loudly
// instead of being papered over.
function createFakeStore(
  seedConversations: readonly ConversationRow[] = [],
  seedEvents: readonly EventRow[] = [],
): {
  readonly store: OrchestrationTenantStore;
  readonly conversations: ConversationRow[];
  readonly events: EventRow[];
} {
  const conversations: ConversationRow[] = seedConversations.map((c) => ({ ...c }));
  const events: EventRow[] = seedEvents.map((e) => ({ ...e }));

  const store: OrchestrationTenantStore = {
    async withTenant(_tenantId, operation) {
      return operation({
        async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
          statement: string,
          values: readonly unknown[] = [],
        ) {
          if (statement.startsWith("SELECT c.id, c.temporal_workflow_id")) {
            const [tenantId, workspaceId, channel, subjectId] = values as [
              string,
              string,
              string,
              string,
            ];
            const match = conversations
              .filter(
                (c) =>
                  c.tenant_id === tenantId &&
                  c.workspace_id === workspaceId &&
                  c.channel === channel &&
                  c.status !== "closed" &&
                  c.status !== "archived",
              )
              .find((c) =>
                events.some(
                  (e) =>
                    e.tenant_id === tenantId &&
                    e.conversation_id === c.id &&
                    e.subject_id === subjectId,
                ),
              );
            return {
              rowCount: match === undefined ? 0 : 1,
              rows: (match === undefined
                ? []
                : [
                    {
                      id: match.id,
                      temporal_workflow_id: match.temporal_workflow_id,
                    },
                  ]) as unknown as readonly TRow[],
            };
          }

          if (statement.startsWith("INSERT INTO conversations")) {
            const [id, tenantId, workspaceId, channel, temporalWorkflowId] =
              values as [string, string, string, string, string];
            conversations.push({
              id,
              tenant_id: tenantId,
              workspace_id: workspaceId,
              channel,
              status: "active",
              temporal_workflow_id: temporalWorkflowId,
            });
            return { rowCount: 1, rows: [] as unknown as readonly TRow[] };
          }

          if (statement.startsWith("UPDATE events SET conversation_id")) {
            const [conversationId, tenantId, idempotencyKey] = values as [
              string,
              string,
              string,
            ];
            const existing = events.find(
              (e) =>
                e.tenant_id === tenantId &&
                e.idempotency_key === idempotencyKey,
            );
            if (existing === undefined) {
              throw new Error(
                `Test setup bug: no seeded events row for idempotency_key ${idempotencyKey} -- ` +
                  "seed one via seedEvents before dispatching, matching how INGR-6 persists it first.",
              );
            }
            if (existing.conversation_id === null) {
              existing.conversation_id = conversationId;
              existing.correlation_id = conversationId;
            }
            return { rowCount: 1, rows: [] as unknown as readonly TRow[] };
          }

          throw new Error(`Unhandled query in fake store: ${statement}`);
        },
      });
    },
  };

  return { store, conversations, events };
}

function inboundMessage(
  overrides: Partial<DispatchableInboundMessage> = {},
): DispatchableInboundMessage {
  return {
    idempotencyKey: "wamid.ABC123",
    subjectId: "16505551234",
    occurredAt: "2026-07-26T12:00:00.000Z",
    payload: { text: { body: "hi" } },
    ...overrides,
  };
}

function seededEventFor(
  message: DispatchableInboundMessage,
  tenantId: string,
): EventRow {
  return {
    tenant_id: tenantId,
    idempotency_key: message.idempotencyKey,
    subject_id: message.subjectId,
    conversation_id: null,
    correlation_id: null,
  };
}

function fakeDispatchClient(): {
  readonly client: ConversationDispatchHandler;
  readonly calls: unknown[];
} {
  const calls: unknown[] = [];
  return {
    client: {
      async dispatchMessage(request) {
        calls.push(request);
        return { workflowId: request.workflowId, signaledRunId: "run_1" };
      },
    },
    calls,
  };
}

const CONFIG = {
  taskQueue: "conversation-lifecycle",
  idleTimeoutSeconds: 1_800,
  historyRolloverEventCount: 500,
};

describe("ConversationDispatchService", () => {
  it("creates a new conversation for a first-time subject and dispatches the message", async () => {
    const message = inboundMessage();
    const { store, conversations, events } = createFakeStore(
      [],
      [seededEventFor(message, "ten_a")],
    );
    const { client, calls } = fakeDispatchClient();
    const service = new ConversationDispatchService(store, client, CONFIG);

    await service.dispatchInboundMessages("ten_a", "ws_a", "whatsapp", [
      message,
    ]);

    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.status).toBe("active");
    expect(conversations[0]!.temporal_workflow_id).toMatch(/^convwf_/);
    expect(events[0]!.conversation_id).toBe(conversations[0]!.id);
    expect(events[0]!.correlation_id).toBe(conversations[0]!.id);

    expect(calls).toHaveLength(1);
    const [call] = calls as [{
      workflowId: string;
      workflowType: string;
      signalName: string;
      signalPayload: { messageId: string; channel: string };
    }];
    expect(call.workflowId).toBe(conversations[0]!.temporal_workflow_id);
    expect(call.workflowType).toBe("conversationLifecycleWorkflow");
    expect(call.signalName).toBe("message");
    expect(call.signalPayload.messageId).toBe("wamid.ABC123");
    expect(call.signalPayload.channel).toBe("whatsapp");
  });

  it("reuses the existing open conversation for a returning subject", async () => {
    const newMessage = inboundMessage({ idempotencyKey: "wamid.NEW" });
    const { store, conversations, events } = createFakeStore(
      [
        {
          id: "conv_existing",
          tenant_id: "ten_a",
          workspace_id: "ws_a",
          channel: "whatsapp",
          status: "active",
          temporal_workflow_id: "convwf_existing",
        },
      ],
      [
        {
          tenant_id: "ten_a",
          idempotency_key: "wamid.PREVIOUS",
          subject_id: "16505551234",
          conversation_id: "conv_existing",
          correlation_id: "conv_existing",
        },
        seededEventFor(newMessage, "ten_a"),
      ],
    );
    const { client, calls } = fakeDispatchClient();
    const service = new ConversationDispatchService(store, client, CONFIG);

    await service.dispatchInboundMessages("ten_a", "ws_a", "whatsapp", [
      newMessage,
    ]);

    expect(conversations).toHaveLength(1);
    const [call] = calls as [{ workflowId: string }];
    expect(call.workflowId).toBe("convwf_existing");
    expect(
      events.find((e) => e.idempotency_key === "wamid.NEW")?.conversation_id,
    ).toBe("conv_existing");
  });

  it("starts a fresh conversation for a subject whose only prior conversation is closed", async () => {
    const newMessage = inboundMessage({ idempotencyKey: "wamid.NEW" });
    const { store, conversations } = createFakeStore(
      [
        {
          id: "conv_closed",
          tenant_id: "ten_a",
          workspace_id: "ws_a",
          channel: "whatsapp",
          status: "closed",
          temporal_workflow_id: "convwf_closed",
        },
      ],
      [
        {
          tenant_id: "ten_a",
          idempotency_key: "wamid.PREVIOUS",
          subject_id: "16505551234",
          conversation_id: "conv_closed",
          correlation_id: "conv_closed",
        },
        seededEventFor(newMessage, "ten_a"),
      ],
    );
    const { client, calls } = fakeDispatchClient();
    const service = new ConversationDispatchService(store, client, CONFIG);

    await service.dispatchInboundMessages("ten_a", "ws_a", "whatsapp", [
      newMessage,
    ]);

    expect(conversations).toHaveLength(2);
    const [call] = calls as [{ workflowId: string }];
    expect(call.workflowId).not.toBe("convwf_closed");
  });

  it("dispatches multiple messages for the same subject to the same conversation, in order", async () => {
    const messageOne = inboundMessage({ idempotencyKey: "wamid.1" });
    const messageTwo = inboundMessage({ idempotencyKey: "wamid.2" });
    const { store } = createFakeStore(
      [],
      [
        seededEventFor(messageOne, "ten_a"),
        seededEventFor(messageTwo, "ten_a"),
      ],
    );
    const { client, calls } = fakeDispatchClient();
    const service = new ConversationDispatchService(store, client, CONFIG);

    await service.dispatchInboundMessages("ten_a", "ws_a", "whatsapp", [
      messageOne,
      messageTwo,
    ]);

    expect(calls).toHaveLength(2);
    const [first, second] = calls as [{ workflowId: string }, { workflowId: string }];
    expect(first.workflowId).toBe(second.workflowId);
  });

  it("propagates a dispatch client failure without swallowing it", async () => {
    const message = inboundMessage();
    const { store } = createFakeStore([], [seededEventFor(message, "ten_a")]);
    const client: ConversationDispatchHandler = {
      async dispatchMessage() {
        throw new Error("temporal unreachable");
      },
    };
    const service = new ConversationDispatchService(store, client, CONFIG);

    await expect(
      service.dispatchInboundMessages("ten_a", "ws_a", "whatsapp", [message]),
    ).rejects.toThrow("temporal unreachable");
  });
});
