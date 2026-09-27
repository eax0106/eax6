import { createEnvironmentValidators } from "@alterx/adapters";

// Config for dispatching verified webhook events into the conversation
// lifecycle Temporal workflow (INGR-7). Kept separate from every other
// config loader in this file's directory -- same reasoning as those: this
// ticket must not perturb any other ticket's wiring.

export interface ConversationDispatchEnvironment {
  readonly temporalAddress: string;
  readonly temporalNamespace: string;
  readonly temporalApiKey: string | undefined;
  readonly taskQueue: string;
  readonly idleTimeoutSeconds: number;
  readonly historyRolloverEventCount: number;
}

export class ConversationDispatchConfigurationError extends Error {
  constructor(field: string, reason: string) {
    super(`Invalid conversation dispatch environment field ${field}: ${reason}`);
    this.name = "ConversationDispatchConfigurationError";
  }
}

const { requireValue } = createEnvironmentValidators(
  (field, reason) => new ConversationDispatchConfigurationError(field, reason),
);

function parseIdleTimeoutSeconds(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) {
    return 1_800;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ConversationDispatchConfigurationError(
      "CONVERSATION_IDLE_TIMEOUT_SECONDS",
      "must be a positive integer",
    );
  }
  return parsed;
}

function parseHistoryRolloverEventCount(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) {
    return 500;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ConversationDispatchConfigurationError(
      "CONVERSATION_HISTORY_ROLLOVER_EVENT_COUNT",
      "must be a positive integer",
    );
  }
  return parsed;
}

export function loadConversationDispatchEnvironment(
  environment: NodeJS.ProcessEnv,
): ConversationDispatchEnvironment {
  return {
    temporalAddress: requireValue(environment, "TEMPORAL_ADDRESS"),
    temporalNamespace: requireValue(environment, "TEMPORAL_NAMESPACE"),
    temporalApiKey: environment.TEMPORAL_API_KEY?.trim() || undefined,
    taskQueue: requireValue(environment, "CONVERSATION_LIFECYCLE_TASK_QUEUE"),
    idleTimeoutSeconds: parseIdleTimeoutSeconds(
      environment.CONVERSATION_IDLE_TIMEOUT_SECONDS,
    ),
    historyRolloverEventCount: parseHistoryRolloverEventCount(
      environment.CONVERSATION_HISTORY_ROLLOVER_EVENT_COUNT,
    ),
  };
}
