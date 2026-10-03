import { describe, expect, it } from "vitest";

import {
  ConversationManagerConfigurationError,
  loadConversationManagerEnvironment,
  loadNodeOverrideThresholds,
} from "./environment";

function environment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ALTER_ENV: "local",
    MODEL_GATEWAY_ADDRESS: "127.0.0.1:50051",
    ...overrides,
  };
}

describe("loadConversationManagerEnvironment", () => {
  it("validates and returns the documented local environment", () => {
    expect(loadConversationManagerEnvironment(environment())).toEqual({
      alterEnvironment: "local",
      runtimeMode: "mock",
      configSource: "local-file",
      modelGatewayAddress: "127.0.0.1:50051",
      grpcBindAddress: "0.0.0.0:50052",
    });
  });

  it("accepts a validated custom bind address", () => {
    expect(
      loadConversationManagerEnvironment(
        environment({ CONVERSATION_GRPC_BIND_ADDRESS: "127.0.0.1:51052" }),
      ),
    ).toMatchObject({ grpcBindAddress: "127.0.0.1:51052" });
  });

  it.each([
    ["ALTER_ENV", { ALTER_ENV: "qa" }],
    ["MODEL_GATEWAY_ADDRESS", { MODEL_GATEWAY_ADDRESS: "" }],
    [
      "CONVERSATION_GRPC_BIND_ADDRESS",
      { CONVERSATION_GRPC_BIND_ADDRESS: "localhost:50052" },
    ],
    [
      "CONVERSATION_GRPC_BIND_ADDRESS",
      { CONVERSATION_GRPC_BIND_ADDRESS: "127.0.0.1:70000" },
    ],
  ])("rejects invalid %s", (field, override) => {
    expect(() =>
      loadConversationManagerEnvironment(environment(override)),
    ).toThrow(ConversationManagerConfigurationError);
    expect(() =>
      loadConversationManagerEnvironment(environment(override)),
    ).toThrow(field);
  });
});

it("reads configurable D20 thresholds and refuses malformed or invalid overrides",()=>{
  expect(loadNodeOverrideThresholds({})).toEqual({costIncreaseRatio:.25,costIncreaseMinor:500,latencyMultiplier:2});
  expect(loadNodeOverrideThresholds({NODE_OVERRIDE_ADVISORY_THRESHOLDS:'{"costIncreaseRatio":0.5,"costIncreaseMinor":1000,"latencyMultiplier":3}'})).toEqual({costIncreaseRatio:.5,costIncreaseMinor:1000,latencyMultiplier:3});
  for (const value of ['{','{"costIncreaseMinor":-1}','{"latencyMultiplier":0.5}','{"unknown":1}']) expect(()=>loadNodeOverrideThresholds({NODE_OVERRIDE_ADVISORY_THRESHOLDS:value})).toThrow("NODE_OVERRIDE_ADVISORY_THRESHOLDS");
});
