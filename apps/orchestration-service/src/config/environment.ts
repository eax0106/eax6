import { createEnvironmentValidators } from "@alterx/adapters";
import { NodeOverrideThresholdsSchema, type NodeOverrideThresholds } from "@alterx/contracts";

export function loadNodeOverrideThresholds(environment:NodeJS.ProcessEnv):NodeOverrideThresholds {
  try {
    return NodeOverrideThresholdsSchema.parse(JSON.parse(environment.NODE_OVERRIDE_ADVISORY_THRESHOLDS?.trim() || "{}"));
  } catch {
    throw new ConversationManagerConfigurationError("NODE_OVERRIDE_ADVISORY_THRESHOLDS","must be valid advisory threshold JSON");
  }
}

// Config for the Conversation Manager (INGR-4) only. Session Gateway's own
// config stays inline in app.module.ts (INGR-2, untouched) -- this file
// intentionally doesn't merge with it, so this ticket can't accidentally
// perturb INGR-2's guard wiring.

const ALTER_ENVIRONMENTS = ["local", "dev", "staging", "prod"] as const;

export interface ConversationManagerEnvironment {
  readonly alterEnvironment: (typeof ALTER_ENVIRONMENTS)[number];
  readonly runtimeMode: "real" | "mock";
  readonly configSource: "appconfig" | "local-file";
  readonly modelGatewayAddress: string;
  readonly grpcBindAddress: string;
}

export class ConversationManagerConfigurationError extends Error {
  constructor(field: string, reason: string) {
    super(`Invalid Conversation Manager environment field ${field}: ${reason}`);
    this.name = "ConversationManagerConfigurationError";
  }
}

const { requireValue, parseGrpcAddress, runtimeMode, configSource: readConfigSource } = createEnvironmentValidators(
  (field, reason) => new ConversationManagerConfigurationError(field, reason),
);

export function loadConversationManagerEnvironment(
  environment: NodeJS.ProcessEnv,
): ConversationManagerEnvironment {
  const alterEnvironment = requireValue(environment, "ALTER_ENV");
  if (
    !ALTER_ENVIRONMENTS.includes(
      alterEnvironment as ConversationManagerEnvironment["alterEnvironment"],
    )
  ) {
    throw new ConversationManagerConfigurationError(
      "ALTER_ENV",
      `must be one of ${ALTER_ENVIRONMENTS.join(", ")}`,
    );
  }

  return {
    alterEnvironment:
      alterEnvironment as ConversationManagerEnvironment["alterEnvironment"],
    runtimeMode: runtimeMode(environment),
    configSource: readConfigSource(environment),
    modelGatewayAddress: requireValue(environment, "MODEL_GATEWAY_ADDRESS"),
    grpcBindAddress: parseGrpcAddress(
      environment.CONVERSATION_GRPC_BIND_ADDRESS,
      "CONVERSATION_GRPC_BIND_ADDRESS",
      "0.0.0.0:50052",
    ),
  };
}
