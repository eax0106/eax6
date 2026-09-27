import {
  ParentClosePolicy,
  allHandlersFinished,
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  log,
  setHandler,
  startChild,
  workflowInfo,
} from "@temporalio/workflow";

import type { JsonValue } from "@alterx/shared-clients";

export type ConversationLifecycleStatus = "active" | "idle" | "closed";

export interface IncomingConversationMessage {
  readonly messageId: string;
  readonly channel: "web" | "whatsapp" | "api";
  readonly payload: JsonValue;
  readonly receivedAt: string;
}

export interface ConversationLifecycleInput {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly idleTimeoutSeconds: number;
  readonly historyRolloverEventCount: number;
}

export interface ConversationLifecycleSnapshot {
  readonly messages: readonly IncomingConversationMessage[];
  readonly seenMessageIds: readonly string[];
  readonly childRunIds: readonly string[];
}

interface ContinuedConversationLifecycleInput extends ConversationLifecycleInput {
  /** Internal state carried between Continue-As-New runs. */
  readonly snapshot: ConversationLifecycleSnapshot;
}

type ConversationLifecycleWorkflowInput =
  | ConversationLifecycleInput
  | ContinuedConversationLifecycleInput;

export interface SpawnChildRunSignalPayload {
  readonly workflowId: string;
  readonly workflowType: string;
  readonly taskQueue: string;
  readonly input: JsonValue;
}

export const messageSignal =
  defineSignal<[IncomingConversationMessage]>("message");
export const spawnChildRunSignal =
  defineSignal<[SpawnChildRunSignalPayload]>("spawnChildRun");
export const closeSignal = defineSignal<[]>("close");

export const messagesQuery =
  defineQuery<readonly IncomingConversationMessage[]>("messages");
export const statusQuery = defineQuery<ConversationLifecycleStatus>("status");
export const childRunIdsQuery = defineQuery<readonly string[]>("childRunIds");

const DEFAULT_HISTORY_ROLLOVER_EVENT_COUNT = 500;
const SNAPSHOT_MAX_MESSAGES = 100;
const SNAPSHOT_MAX_CHILD_RUN_IDS = 1_000;
const SNAPSHOT_MAX_SEEN_MESSAGE_IDS = 2_000;
const SNAPSHOT_MAX_MESSAGE_JSON_CHARACTERS = 200_000;

function recentMessagesForSnapshot(
  messages: readonly IncomingConversationMessage[],
): readonly IncomingConversationMessage[] {
  const recent: IncomingConversationMessage[] = [];
  let jsonCharacters = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || recent.length >= SNAPSHOT_MAX_MESSAGES) break;
    const size = JSON.stringify(message).length;
    if (jsonCharacters + size > SNAPSHOT_MAX_MESSAGE_JSON_CHARACTERS) break;
    recent.push(message);
    jsonCharacters += size;
  }
  return recent.reverse();
}

function snapshotState(
  messages: readonly IncomingConversationMessage[],
  seenMessageIds: ReadonlySet<string>,
  childRunIds: readonly string[],
): ConversationLifecycleSnapshot {
  return {
    // The events table remains the complete durable conversation history.
    // Workflow state carries only a bounded recent query/dedupe window so a
    // Continue-As-New input cannot grow until it hits Temporal's payload cap.
    messages: recentMessagesForSnapshot(messages),
    seenMessageIds: [...seenMessageIds].slice(-SNAPSHOT_MAX_SEEN_MESSAGE_IDS),
    childRunIds: childRunIds.slice(-SNAPSHOT_MAX_CHILD_RUN_IDS),
  };
}

export async function conversationLifecycleWorkflow(
  input: ConversationLifecycleWorkflowInput,
): Promise<void> {
  const snapshot = "snapshot" in input ? input.snapshot : undefined;
  const messages: IncomingConversationMessage[] = [...(snapshot?.messages ?? [])];
  const seenMessageIds = new Set<string>(snapshot?.seenMessageIds ?? []);
  const childRunIds: string[] = [...(snapshot?.childRunIds ?? [])];
  let status: ConversationLifecycleStatus = "active";
  let closeRequested = false;
  // Deterministic activity counter instead of Date.now()-based idle math --
  // any signal that represents "the conversation is alive" bumps this, and
  // the wait loop below resets its idle clock whenever it moves.
  let activityCounter = 0;
  let eventsInRun = 0;

  setHandler(messageSignal, (message) => {
    if (seenMessageIds.has(message.messageId)) {
      return;
    }
    seenMessageIds.add(message.messageId);
    messages.push(message);
    activityCounter += 1;
    eventsInRun += 1;
  });

  setHandler(spawnChildRunSignal, async (payload) => {
    activityCounter += 1;
    eventsInRun += 1;
    try {
      // ABANDON: a spawned run (e.g. a workflow execution triggered mid
      // conversation) must keep going even if this conversation closes or
      // idles out afterward -- the two lifecycles are intentionally decoupled.
      const handle = await startChild(payload.workflowType, {
        workflowId: payload.workflowId,
        taskQueue: payload.taskQueue,
        args: [payload.input],
        parentClosePolicy: ParentClosePolicy.ABANDON,
      });
      childRunIds.push(handle.workflowId);
    } catch (error) {
      // A bad payload (e.g. a reused child workflowId) must not crash this
      // conversation's own workflow task -- log and keep the conversation alive.
      log.warn("conversationLifecycleWorkflow: failed to spawn child run", {
        workflowId: payload.workflowId,
        workflowType: payload.workflowType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  setHandler(closeSignal, () => {
    closeRequested = true;
  });

  setHandler(messagesQuery, () => messages);
  setHandler(statusQuery, () => status);
  setHandler(childRunIdsQuery, () => childRunIds);

  const idleTimeoutMs = input.idleTimeoutSeconds * 1000;
  const rolloverEventCount = Math.max(
    1,
    input.historyRolloverEventCount || DEFAULT_HISTORY_ROLLOVER_EVENT_COUNT,
  );
  while (!closeRequested) {
    const counterAtWaitStart = activityCounter;
    const activityHappened = await condition(
      () => closeRequested || activityCounter > counterAtWaitStart,
      idleTimeoutMs,
    );
    if (!activityHappened) {
      status = "idle";
      break;
    }
    if (!closeRequested) {
      status = "active";
    }
    if (
      !closeRequested &&
      (eventsInRun >= rolloverEventCount || workflowInfo().continueAsNewSuggested)
    ) {
      await condition(allHandlersFinished);
      await continueAsNew<typeof conversationLifecycleWorkflow>({
        ...input,
        snapshot: snapshotState(messages, seenMessageIds, childRunIds),
      });
    }
  }

  status = "closed";
  await condition(allHandlersFinished);
}
