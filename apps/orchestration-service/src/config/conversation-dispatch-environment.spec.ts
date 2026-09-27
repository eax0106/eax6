import { describe, expect, it } from "vitest";

import {
  ConversationDispatchConfigurationError,
  loadConversationDispatchEnvironment,
} from "./conversation-dispatch-environment";

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    TEMPORAL_ADDRESS: "temporal.internal:7233",
    TEMPORAL_NAMESPACE: "engine",
    CONVERSATION_LIFECYCLE_TASK_QUEUE: "conversation-lifecycle",
    ...overrides,
  };
}

describe("loadConversationDispatchEnvironment", () => {
  it("uses bounded production-safe defaults", () => {
    expect(loadConversationDispatchEnvironment(environment())).toEqual({
      temporalAddress: "temporal.internal:7233",
      temporalNamespace: "engine",
      temporalApiKey: undefined,
      taskQueue: "conversation-lifecycle",
      idleTimeoutSeconds: 1_800,
      historyRolloverEventCount: 500,
    });
  });

  it("accepts a custom positive history rollover event count", () => {
    expect(
      loadConversationDispatchEnvironment(
        environment({ CONVERSATION_HISTORY_ROLLOVER_EVENT_COUNT: "250" }),
      ).historyRolloverEventCount,
    ).toBe(250);
  });

  it("rejects a non-positive history rollover event count", () => {
    expect(() =>
      loadConversationDispatchEnvironment(
        environment({ CONVERSATION_HISTORY_ROLLOVER_EVENT_COUNT: "0" }),
      ),
    ).toThrow(ConversationDispatchConfigurationError);
  });
});
