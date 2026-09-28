import {
  createMockCacheProvider,
  createMockConfigProvider,
  createMockEmbeddingProvider,
  createMockModelProvider,
  createMockPIIRedactionProvider,
  createMockQueueProvider,
  type CacheProvider,
  type ConfigProvider,
  type EmbeddingProvider,
  type ModelProvider,
  type PIIRedactionProvider,
  type QueueProvider,
} from "@alterx/shared-clients";
import type { CostHandlerClient } from "@alterx/adapters";
import { describe, expect, it, vi, type Mock } from "vitest";

import { cacheKey, ModelGatewayService } from "./model-gateway.service";

const COST_EVENTS_QUEUE_NAME = "alter-dev-cost-events";

function request(overrides: Partial<Parameters<ModelGatewayService["invoke"]>[0]> = {}) {
  return {
    tenant_id: "ten_018f47a2-7b11-7b11-8a11-1234567890ab",
    run_id: "run_018f47a2-7b11-7b11-8a11-1234567890ab",
    node_execution_id: "node_018f47a2-7b11-7b11-8a11-1234567890ab",
    model_alias: "STANDARD",
    input_json: JSON.stringify({
      messages: [{ role: "user", content: "hello" }],
    }),
    ...overrides,
  };
}

interface ServiceOverrides {
  readonly configProvider?: ConfigProvider;
  readonly modelProvider?: ModelProvider;
  readonly piiRedactionProvider?: PIIRedactionProvider;
  readonly embeddingProvider?: EmbeddingProvider;
  readonly cacheProvider?: CacheProvider;
  readonly queueProvider?: QueueProvider;
  readonly costEventsQueueName?: string;
  readonly costClient?: CostHandlerClient;
}

function buildService(overrides: ServiceOverrides = {}): ModelGatewayService {
  return new ModelGatewayService(
    overrides.configProvider ?? createMockConfigProvider(),
    overrides.modelProvider ?? createMockModelProvider(),
    overrides.piiRedactionProvider ?? createMockPIIRedactionProvider(),
    overrides.embeddingProvider ?? createMockEmbeddingProvider(),
    overrides.cacheProvider ?? createMockCacheProvider(),
    overrides.queueProvider ?? createMockQueueProvider(),
    overrides.costEventsQueueName ?? COST_EVENTS_QUEUE_NAME,
    overrides.costClient ?? {
      ingestCostEvent: async () => ({ accepted: true }),
      resolveUnitPrice: async () => ({
        unit_cost_minor: "10", // Small value to not trip limit
        currency: "INR",
        confidence: "fixed_table",
      }),
      recordModelOutcome: async () => ({ accepted: true }),
    }
  );
}

describe("ModelGatewayService", () => {
  it("resolves the alias via config only and delegates the call to the model provider", async () => {
    const configProvider = createMockConfigProvider();
    const invoke = vi.fn(createMockModelProvider().invoke);
    const modelProvider = createMockModelProvider({ invoke });
    const service = buildService({ configProvider, modelProvider });

    const response = await service.invoke(request());

    expect(invoke).toHaveBeenCalledWith({
      tenantId: "ten_018f47a2-7b11-7b11-8a11-1234567890ab",
      runId: "run_018f47a2-7b11-7b11-8a11-1234567890ab",
      nodeExecutionId: "node_018f47a2-7b11-7b11-8a11-1234567890ab",
      modelId: "mock.standard.v1",
      capabilityTags: ["general"],
      inputJson: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(response.resolved_capability).toBe("STANDARD:mock.model");
    expect(JSON.parse(response.output_json)).toEqual({
      message: {
        role: "assistant",
        content: "mock response to: hello",
      },
      stop_reason: "end_turn",
    });
  });

  it("resolves a different model per alias tier -- never a hardcoded model", async () => {
    const configProvider = createMockConfigProvider();
    const invoke = vi.fn(createMockModelProvider().invoke);
    const modelProvider = createMockModelProvider({ invoke });
    const service = buildService({ configProvider, modelProvider });

    await service.invoke(request({ model_alias: "CEILING" }));

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "mock.ceiling.v1" }),
    );
  });

  it("threads the alias binding's fallback_chain through to the model provider", async () => {
    const configProvider = createMockConfigProvider({
      policy: {
        version: "test.1",
        bindings: {
          FAST: { model_id: "mock.fast.v1", capability_tags: [] },
          STANDARD: {
            model_id: "mock.standard.v1",
            capability_tags: ["general"],
            fallback_chain: [
              { provider: "anthropic", model_id: "claude-sonnet-5" },
              { provider: "openai", model_id: "gpt-5" },
            ],
          },
          ADVANCED: { model_id: "mock.advanced.v1", capability_tags: [] },
          CEILING: { model_id: "mock.ceiling.v1", capability_tags: [] },
        },
      },
    });
    const invoke = vi.fn(createMockModelProvider().invoke);
    const modelProvider = createMockModelProvider({ invoke });
    const service = buildService({ configProvider, modelProvider });

    await service.invoke(request());

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        fallbackChain: [
          { provider: "anthropic", model_id: "claude-sonnet-5" },
          { provider: "openai", model_id: "gpt-5" },
        ],
      }),
    );
  });

  it("reflects the provider that actually served the call, not just the requested alias -- no silent downgrade", async () => {
    const configProvider = createMockConfigProvider();
    const modelProvider = createMockModelProvider({
      invoke: async () => ({
        outputJson: JSON.stringify({
          message: { role: "assistant", content: "fallback response" },
          stop_reason: "end_turn",
        }),
        usageJson: JSON.stringify({ input_tokens: 1, output_tokens: 1 }),
        servedBy: "anthropic-direct",
      }),
    });
    const service = buildService({ configProvider, modelProvider });

    const response = await service.invoke(request());

    expect(response.resolved_capability).toBe("STANDARD:anthropic-direct");
  });

  it("rejects a model_alias that is not one of the four tiers", async () => {
    const service = buildService();

    await expect(
      service.invoke(request({ model_alias: "ULTRA" })),
    ).rejects.toThrow(/not a recognized alias tier/);
  });

  it("redacts PII out of input_json before it reaches the model provider -- GATE-1's outbound path", async () => {
    const configProvider = createMockConfigProvider();
    const invoke = vi.fn(createMockModelProvider().invoke);
    const modelProvider = createMockModelProvider({ invoke });
    const piiRedactionProvider = createMockPIIRedactionProvider();
    const service = buildService({
      configProvider,
      modelProvider,
      piiRedactionProvider,
    });

    await service.invoke(
      request({
        input_json: JSON.stringify({
          messages: [{ role: "user", content: "my PAN is ABCDE1234F" }],
        }),
      }),
    );

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        inputJson: JSON.stringify({
          messages: [{ role: "user", content: "my PAN is <IN_PAN>" }],
        }),
      }),
    );
  });

  it("forwards an Alter-authored system prompt unredacted and strips the marker", async () => {
    const invoke = vi.fn(createMockModelProvider().invoke);
    const service = buildService({
      modelProvider: createMockModelProvider({ invoke }),
      piiRedactionProvider: createMockPIIRedactionProvider(),
    });

    await service.invoke(
      request({
        input_json: JSON.stringify({
          messages: [
            { role: "system", content: "Tool list; PAN ABCDE1234F", alter_authored: true },
            { role: "system", content: "Agent persona; PAN ABCDE1234F" },
            { role: "user", content: "my PAN is ABCDE1234F", alter_authored: true },
          ],
          temperature: 0,
        }),
      }),
    );

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        inputJson: JSON.stringify({
          messages: [
            { role: "system", content: "Tool list; PAN ABCDE1234F" },
            { role: "system", content: "Agent persona; PAN <IN_PAN>" },
            { role: "user", content: "my PAN is <IN_PAN>" },
          ],
          temperature: 0,
        }),
      }),
    );
  });

  it("redact() delegates to the PIIRedactionProvider and reports a redaction count", async () => {
    const service = buildService();

    const response = await service.redact({
      tenant_id: "ten_018f47a2-7b11-7b11-8a11-1234567890ab",
      run_id: "run_018f47a2-7b11-7b11-8a11-1234567890ab",
      content: "PAN on file: ABCDE1234F",
    });

    expect(response).toEqual({
      redacted_content: "PAN on file: <IN_PAN>",
      redaction_count: 1,
    });
  });

  it("redact() returns the text unchanged and a zero count when no PII is present", async () => {
    const service = buildService();

    const response = await service.redact({
      tenant_id: "ten_018f47a2-7b11-7b11-8a11-1234567890ab",
      run_id: "run_018f47a2-7b11-7b11-8a11-1234567890ab",
      content: "nothing sensitive here",
    });

    expect(response).toEqual({
      redacted_content: "nothing sensitive here",
      redaction_count: 0,
    });
  });

  it("embed() delegates to the EmbeddingProvider and returns its real vector", async () => {
    const embed = vi.fn(createMockEmbeddingProvider().embed);
    const embeddingProvider = createMockEmbeddingProvider({ embed });
    const service = buildService({ embeddingProvider });

    const response = await service.embed({
      tenant_id: "ten_018f47a2-7b11-7b11-8a11-1234567890ab",
      text: "hello world",
      dimensions: 1024,
    });

    expect(embed).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "ten_018f47a2-7b11-7b11-8a11-1234567890ab",
        text: "hello world",
        dimensions: 1024,
      }),
    );
    expect(response.dimensions).toBe(1024);
    expect(response.embedding).toHaveLength(1024);
    expect(response.model_id).toBe("mock.embedding");
  });

  it("embed() never swallows a provider failure -- unlike the internal cache best-effort path", async () => {
    const embeddingProvider = createMockEmbeddingProvider({
      embed: async () => {
        throw new Error("bedrock throttled");
      },
    });
    const service = buildService({ embeddingProvider });

    await expect(
      service.embed({
        tenant_id: "ten_018f47a2-7b11-7b11-8a11-1234567890ab",
        text: "hello world",
        dimensions: 512,
      }),
    ).rejects.toThrow("bedrock throttled");
  });

  it("embed() rejects a dimensions value that is not 512 or 1024", async () => {
    const service = buildService();

    await expect(
      service.embed({
        tenant_id: "ten_018f47a2-7b11-7b11-8a11-1234567890ab",
        text: "hello world",
        dimensions: 768,
      }),
    ).rejects.toThrow(/512 or 1024/);
  });

  it("forwards model deltas incrementally instead of buffering the completion", async () => {
    let releaseSecond!: () => void;
    const secondAllowed = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const stream = vi.fn(async function* () {
      yield {
        sequence: 1,
        delta: "first",
        final: false as const,
        servedBy: "aws-bedrock",
      };
      await secondAllowed;
      yield {
        sequence: 2,
        delta: " second",
        final: false as const,
        servedBy: "aws-bedrock",
      };
      yield {
        sequence: 3,
        delta: "",
        final: true as const,
        usageJson: JSON.stringify({ input_tokens: 2, output_tokens: 2 }),
        servedBy: "aws-bedrock",
      };
    });
    const service = buildService({
      modelProvider: createMockModelProvider({ stream }),
    });
    const iterator = service.stream(request())[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { sequence: 1, delta: "first", final: false, usage_json: "", estimated_cost_usd: "" },
    });
    const second = iterator.next();
    let secondSettled = false;
    void second.finally(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    releaseSecond();
    await expect(second).resolves.toMatchObject({
      value: { sequence: 2, delta: " second", final: false },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { sequence: 3, delta: "", final: true },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("redacts PII before opening the provider stream", async () => {
    const stream = vi.fn(async function* () {
      yield {
        sequence: 1,
        delta: "",
        final: true as const,
        usageJson: JSON.stringify({ input_tokens: 1, output_tokens: 0 }),
        servedBy: "aws-bedrock",
      };
    });
    const service = buildService({
      modelProvider: createMockModelProvider({ stream }),
    });

    const iterator = service.stream(
      request({
        input_json: JSON.stringify({
          messages: [{ role: "user", content: "my PAN is ABCDE1234F" }],
        }),
      }),
    )[Symbol.asyncIterator]();
    while (!(await iterator.next()).done) {
      // Drain stream so final usage validation runs.
    }

    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        inputJson: JSON.stringify({
          messages: [{ role: "user", content: "my PAN is <IN_PAN>" }],
        }),
      }),
    );
  });

  it("rejects a stream that ends without a terminal usage chunk", async () => {
    const service = buildService({
      modelProvider: createMockModelProvider({
        stream: async function* () {
          yield {
            sequence: 1,
            delta: "unfinished",
            final: false,
            servedBy: "aws-bedrock",
          };
        },
      }),
    });

    const drain = async () => {
      const iterator = service.stream(request())[Symbol.asyncIterator]();
      while (!(await iterator.next()).done) {
        // Drain malformed stream to force end-of-stream validation.
      }
    };
    await expect(drain()).rejects.toThrow(/without a final usage chunk/);
  });

  it("emits stream usage to the cost queue after the terminal chunk", async () => {
    const publish = vi.fn(async () => undefined);
    const service = buildService({
      queueProvider: createMockQueueProvider({ publish }),
      modelProvider: createMockModelProvider({
        stream: async function* () {
          yield {
            sequence: 1,
            delta: "done",
            final: false,
            servedBy: "mock.model",
          };
          yield {
            sequence: 2,
            delta: "",
            final: true,
            usageJson: JSON.stringify({ input_tokens: 4, output_tokens: 4 }),
            servedBy: "mock.model",
          };
        },
      }),
    });

    const chunks = [];
    for await (const chunk of service.stream(request())) {
      chunks.push(chunk);
    }

    expect(chunks.at(-1)).toMatchObject({ final: true });
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(
      COST_EVENTS_QUEUE_NAME,
      expect.objectContaining({
        tenant_id: request().tenant_id,
        usage_json: JSON.stringify({ input_tokens: 4, output_tokens: 4 }),
      }),
    );
  });

  it("fails a streamed completion closed when terminal usage exceeds its cost limit", async () => {
    const service = buildService({
      configProvider: createMockConfigProvider({
        costLimit: { maxTokensPerCall: 1, maxCostUsdPerCall: 1 },
      }),
      modelProvider: createMockModelProvider({
        stream: async function* () {
          yield {
            sequence: 1,
            delta: "done",
            final: false,
            servedBy: "mock.model",
          };
          yield {
            sequence: 2,
            delta: "",
            final: true,
            usageJson: JSON.stringify({ input_tokens: 2, output_tokens: 2 }),
            servedBy: "mock.model",
          };
        },
      }),
    });
    const drain = async () => {
      const iterator = service.stream(request())[Symbol.asyncIterator]();
      while (!(await iterator.next()).done) {
        // Drain until terminal usage is checked.
      }
    };

    await expect(drain()).rejects.toThrow(/tokens exceeds the resolved limit/);
  });

  it("emits a cost event to the configured queue on a successful invocation", async () => {
    const publish: Mock<(queueName: string, message: unknown) => Promise<void>> =
      vi.fn(async () => undefined);
    const queueProvider = createMockQueueProvider({ publish });
    const modelProvider = createMockModelProvider({
      invoke: async () => ({
        outputJson: JSON.stringify({
          message: { role: "assistant", content: "hi" },
          stop_reason: "end_turn",
        }),
        usageJson: JSON.stringify({ input_tokens: 100, output_tokens: 50 }),
        servedBy: "aws-bedrock",
      }),
    });
    const service = buildService({ modelProvider, queueProvider });

    await service.invoke(request());

    expect(publish).toHaveBeenCalledTimes(1);
    const call = publish.mock.calls[0];
    if (call === undefined) {
      throw new Error("publish was not called");
    }
    const [queueName, message] = call;
    const messageRecord = message as Record<string, string>;
    expect(queueName).toBe(COST_EVENTS_QUEUE_NAME);
    expect(messageRecord).toMatchObject({
      tenant_id: "ten_018f47a2-7b11-7b11-8a11-1234567890ab",
      run_id: "run_018f47a2-7b11-7b11-8a11-1234567890ab",
      node_execution_id: "node_018f47a2-7b11-7b11-8a11-1234567890ab",
      provider_reference: "aws-bedrock",
      usage_json: JSON.stringify({ input_tokens: 100, output_tokens: 50 }),
      source: "model_gateway",
    });
    expect(messageRecord.cost_event_id).toMatch(/^cst_/);
    expect(JSON.parse(messageRecord.amount_json ?? "")).toMatchObject({
      estimated: true,
    });
    expect(new Date(messageRecord.occurred_at ?? "").toString()).not.toBe("Invalid Date");
  });

  it("returns a successful response even when cost-event publish fails -- best-effort, never blocks", async () => {
    const queueProvider = createMockQueueProvider({
      publish: async () => {
        throw new Error("queue unreachable");
      },
    });
    const service = buildService({ queueProvider });

    await expect(service.invoke(request())).resolves.toMatchObject({
      resolved_capability: "STANDARD:mock.model",
    });
  });

  it("rejects an over-limit call with RESOURCE_EXHAUSTED-mapped error, after still emitting the cost event", async () => {
    const publish = vi.fn(async () => undefined);
    const queueProvider = createMockQueueProvider({ publish });
    const configProvider = createMockConfigProvider({
      costLimit: { maxTokensPerCall: 10, maxCostUsdPerCall: 5 },
    });
    const modelProvider = createMockModelProvider({
      invoke: async () => ({
        outputJson: JSON.stringify({
          message: { role: "assistant", content: "hi" },
          stop_reason: "end_turn",
        }),
        usageJson: JSON.stringify({ input_tokens: 5_000, output_tokens: 5_000 }),
        servedBy: "aws-bedrock",
      }),
    });
    const service = buildService({ configProvider, modelProvider, queueProvider });

    await expect(service.invoke(request())).rejects.toThrow(
      /exceeds the resolved limit/,
    );
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("records a success outcome for the real serving provider on a successful invocation", async () => {
    const recordModelOutcome = vi.fn(async () => ({ accepted: true }));
    const modelProvider = createMockModelProvider({
      invoke: async () => ({
        outputJson: JSON.stringify({
          message: { role: "assistant", content: "hi" },
          stop_reason: "end_turn",
        }),
        usageJson: JSON.stringify({ input_tokens: 100, output_tokens: 50 }),
        servedBy: "aws-bedrock",
      }),
    });
    const service = buildService({
      modelProvider,
      costClient: {
        ingestCostEvent: async () => ({ accepted: true }),
        resolveUnitPrice: async () => ({
          unit_cost_minor: "10",
          currency: "INR",
          confidence: "fixed_table",
        }),
        recordModelOutcome,
      },
    });

    await service.invoke(request());

    expect(recordModelOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "ten_018f47a2-7b11-7b11-8a11-1234567890ab",
        run_id: "run_018f47a2-7b11-7b11-8a11-1234567890ab",
        node_execution_id: "node_018f47a2-7b11-7b11-8a11-1234567890ab",
        provider: "aws-bedrock",
        resource: "tokens",
        verdict: "success",
      }),
    );
  });

  it("records a failure outcome for the resolved model when the model provider itself throws", async () => {
    const recordModelOutcome = vi.fn(async () => ({ accepted: true }));
    const modelProvider = createMockModelProvider({
      invoke: async () => {
        throw new Error("bedrock unreachable");
      },
    });
    const service = buildService({
      modelProvider,
      costClient: {
        ingestCostEvent: async () => ({ accepted: true }),
        resolveUnitPrice: async () => ({
          unit_cost_minor: "10",
          currency: "INR",
          confidence: "fixed_table",
        }),
        recordModelOutcome,
      },
    });

    await expect(service.invoke(request())).rejects.toThrow("bedrock unreachable");

    expect(recordModelOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "ten_018f47a2-7b11-7b11-8a11-1234567890ab",
        provider: "mock.standard.v1",
        resource: "tokens",
        verdict: "failure",
      }),
    );
  });

  it("returns a successful response even when outcome recording fails -- best-effort, never blocks", async () => {
    const service = buildService({
      costClient: {
        ingestCostEvent: async () => ({ accepted: true }),
        resolveUnitPrice: async () => ({
          unit_cost_minor: "10",
          currency: "INR",
          confidence: "fixed_table",
        }),
        recordModelOutcome: async () => {
          throw new Error("cost ledger unreachable");
        },
      },
    });

    await expect(service.invoke(request())).resolves.toMatchObject({
      resolved_capability: "STANDARD:mock.model",
    });
  });

  it("records exactly one success outcome for a streamed completion, keyed by the terminal chunk's provider", async () => {
    const recordModelOutcome = vi.fn(async () => ({ accepted: true }));
    const service = buildService({
      modelProvider: createMockModelProvider({
        stream: async function* () {
          yield {
            sequence: 1,
            delta: "done",
            final: false,
            servedBy: "mock.model",
          };
          yield {
            sequence: 2,
            delta: "",
            final: true,
            usageJson: JSON.stringify({ input_tokens: 4, output_tokens: 4 }),
            servedBy: "mock.model",
          };
        },
      }),
      costClient: {
        ingestCostEvent: async () => ({ accepted: true }),
        resolveUnitPrice: async () => ({
          unit_cost_minor: "10",
          currency: "INR",
          confidence: "fixed_table",
        }),
        recordModelOutcome,
      },
    });

    const iterator = service.stream(request())[Symbol.asyncIterator]();
    while (!(await iterator.next()).done) {
      // Drain to the terminal chunk.
    }

    expect(recordModelOutcome).toHaveBeenCalledTimes(1);
    expect(recordModelOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "mock.model", verdict: "success" }),
    );
  });

  it("records exactly one failure outcome, not a contradictory second one, when a streamed completion is closed for exceeding its cost limit", async () => {
    const recordModelOutcome = vi.fn(async () => ({ accepted: true }));
    const service = buildService({
      configProvider: createMockConfigProvider({
        costLimit: { maxTokensPerCall: 1, maxCostUsdPerCall: 1 },
      }),
      modelProvider: createMockModelProvider({
        stream: async function* () {
          yield {
            sequence: 1,
            delta: "done",
            final: false,
            servedBy: "mock.model",
          };
          yield {
            sequence: 2,
            delta: "",
            final: true,
            usageJson: JSON.stringify({ input_tokens: 2, output_tokens: 2 }),
            servedBy: "mock.model",
          };
        },
      }),
      costClient: {
        ingestCostEvent: async () => ({ accepted: true }),
        resolveUnitPrice: async () => ({
          unit_cost_minor: "10",
          currency: "INR",
          confidence: "fixed_table",
        }),
        recordModelOutcome,
      },
    });
    const drain = async () => {
      const iterator = service.stream(request())[Symbol.asyncIterator]();
      while (!(await iterator.next()).done) {
        // Drain until terminal usage is checked.
      }
    };

    await expect(drain()).rejects.toThrow(/tokens exceeds the resolved limit/);

    // The terminal chunk's real model call already succeeded -- only the
    // gateway's own post-hoc limit check rejected it, so exactly the one
    // "success" outcome recorded at the terminal chunk is correct, not a
    // second, contradictory "failure" for the same real call.
    expect(recordModelOutcome).toHaveBeenCalledTimes(1);
    expect(recordModelOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: "success" }),
    );
  });

  it("records a failure outcome when a stream ends without a terminal usage chunk", async () => {
    const recordModelOutcome = vi.fn(async () => ({ accepted: true }));
    const service = buildService({
      modelProvider: createMockModelProvider({
        stream: async function* () {
          yield {
            sequence: 1,
            delta: "unfinished",
            final: false,
            servedBy: "aws-bedrock",
          };
        },
      }),
      costClient: {
        ingestCostEvent: async () => ({ accepted: true }),
        resolveUnitPrice: async () => ({
          unit_cost_minor: "10",
          currency: "INR",
          confidence: "fixed_table",
        }),
        recordModelOutcome,
      },
    });

    const drain = async () => {
      const iterator = service.stream(request())[Symbol.asyncIterator]();
      while (!(await iterator.next()).done) {
        // Drain malformed stream to force end-of-stream validation.
      }
    };
    await expect(drain()).rejects.toThrow(/without a final usage chunk/);

    expect(recordModelOutcome).toHaveBeenCalledTimes(1);
    expect(recordModelOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "aws-bedrock", verdict: "failure" }),
    );
  });

  it("rejects a call whose estimated cost exceeds the resolved USD limit", async () => {
    const configProvider = createMockConfigProvider({
      costLimit: { maxTokensPerCall: 1_000_000, maxCostUsdPerCall: 0.0001 },
    });
    const modelProvider = createMockModelProvider({
      invoke: async () => ({
        outputJson: JSON.stringify({
          message: { role: "assistant", content: "hi" },
          stop_reason: "end_turn",
        }),
        usageJson: JSON.stringify({ input_tokens: 1_000, output_tokens: 1_000 }),
        servedBy: "aws-bedrock",
      }),
    });
    const service = buildService({ configProvider, modelProvider });

    await expect(service.invoke(request())).rejects.toThrow(
      /exceeds the resolved limit/,
    );
  });

  // ENGINE-FIX-B5-9: a Cost Ledger outage used to fall back to a unit price
  // that Math.round()-ed to exactly 0 -- a $0 estimate can never exceed any
  // limit, so the cost-limit guard silently stopped enforcing for the
  // entire outage window. These three tests prove that's fixed, using the
  // exact repro shape from the audit (2,000 tokens at the fallback
  // ESTIMATED_USD_PER_TOKEN of $0.00001/token = $0.02 -- real money, not
  // the $0 the old rounding produced).
  it("still trips the cost-limit guard during a Cost Ledger outage (fallback unit-price path)", async () => {
    const configProvider = createMockConfigProvider({
      costLimit: { maxTokensPerCall: 1_000_000, maxCostUsdPerCall: 0.0001 },
    });
    const modelProvider = createMockModelProvider({
      invoke: async () => ({
        outputJson: JSON.stringify({
          message: { role: "assistant", content: "hi" },
          stop_reason: "end_turn",
        }),
        usageJson: JSON.stringify({ input_tokens: 1_000, output_tokens: 1_000 }),
        servedBy: "aws-bedrock",
      }),
    });
    const service = buildService({
      configProvider,
      modelProvider,
      costClient: {
        ingestCostEvent: async () => ({ accepted: true }),
        resolveUnitPrice: async () => {
          throw new Error("Cost Ledger unreachable");
        },
        recordModelOutcome: async () => ({ accepted: true }),
      },
    });

    await expect(service.invoke(request())).rejects.toThrow(
      /exceeds the resolved limit/,
    );
  });

  it("still trips the cost-limit guard when Cost Ledger has no price at all", async () => {
    // Cost Ledger answers no_data with unit_cost_minor "0". Read literally that
    // is a $0 estimate, which can never exceed a limit. Invisible while the
    // gateway's cost client sent no credential -- every lookup failed before
    // reaching this branch -- and live the moment it authenticates (#168).
    const configProvider = createMockConfigProvider({
      costLimit: { maxTokensPerCall: 1_000_000, maxCostUsdPerCall: 0.0001 },
    });
    const modelProvider = createMockModelProvider({
      invoke: async () => ({
        outputJson: JSON.stringify({
          message: { role: "assistant", content: "hi" },
          stop_reason: "end_turn",
        }),
        usageJson: JSON.stringify({ input_tokens: 1_000, output_tokens: 1_000 }),
        servedBy: "aws-bedrock",
      }),
    });
    const service = buildService({
      configProvider,
      modelProvider,
      costClient: {
        ingestCostEvent: async () => ({ accepted: true }),
        resolveUnitPrice: async () => ({ unit_cost_minor: "0", currency: "INR", confidence: "no_data" }),
        recordModelOutcome: async () => ({ accepted: true }),
      },
    });

    await expect(service.invoke(request())).rejects.toThrow(
      /exceeds the resolved limit/,
    );
  });

  it("records nonzero spend during a Cost Ledger outage instead of silently $0", async () => {
    const publish: Mock<(queueName: string, message: unknown) => Promise<void>> =
      vi.fn(async () => undefined);
    const queueProvider = createMockQueueProvider({ publish });
    // High enough that the fallback-priced call does NOT trip the guard --
    // this test is about what gets recorded, not about tripping.
    const configProvider = createMockConfigProvider({
      costLimit: { maxTokensPerCall: 1_000_000, maxCostUsdPerCall: 5 },
    });
    const modelProvider = createMockModelProvider({
      invoke: async () => ({
        outputJson: JSON.stringify({
          message: { role: "assistant", content: "hi" },
          stop_reason: "end_turn",
        }),
        usageJson: JSON.stringify({ input_tokens: 1_000, output_tokens: 1_000 }),
        servedBy: "aws-bedrock",
      }),
    });
    const service = buildService({
      configProvider,
      modelProvider,
      queueProvider,
      costClient: {
        ingestCostEvent: async () => ({ accepted: true }),
        resolveUnitPrice: async () => {
          throw new Error("Cost Ledger unreachable");
        },
        recordModelOutcome: async () => ({ accepted: true }),
      },
    });

    await service.invoke(request());

    expect(publish).toHaveBeenCalledTimes(1);
    const call = publish.mock.calls[0];
    if (call === undefined) {
      throw new Error("publish was not called");
    }
    const [, message] = call;
    const amount = JSON.parse((message as Record<string, string>).amount_json ?? "") as {
      usd: number;
      estimated: boolean;
    };
    // 2,000 tokens * $0.00001/token fallback price = $0.02 -- the old
    // Math.round() collapsed this to exactly 0.
    expect(amount.usd).toBeCloseTo(0.02, 5);
    expect(amount.usd).toBeGreaterThan(0);
  });

  it("uses the real resolved unit price, not the fallback constant, when Cost Ledger is reachable", async () => {
    const publish: Mock<(queueName: string, message: unknown) => Promise<void>> =
      vi.fn(async () => undefined);
    const queueProvider = createMockQueueProvider({ publish });
    const modelProvider = createMockModelProvider({
      invoke: async () => ({
        outputJson: JSON.stringify({
          message: { role: "assistant", content: "hi" },
          stop_reason: "end_turn",
        }),
        usageJson: JSON.stringify({ input_tokens: 1_000, output_tokens: 1_000 }),
        servedBy: "aws-bedrock",
      }),
    });
    const configProvider = createMockConfigProvider({
      costLimit: { maxTokensPerCall: 1_000_000, maxCostUsdPerCall: 1_000 },
    });
    const service = buildService({
      configProvider,
      modelProvider,
      queueProvider,
      costClient: {
        ingestCostEvent: async () => ({ accepted: true }),
        // A real per-token price far from the $0.00001 fallback constant --
        // if the fallback path leaked into the success path, this
        // assertion below would fail.
        resolveUnitPrice: async () => ({
          unit_cost_minor: "830",
          currency: "INR",
          confidence: "fixed_table",
        }),
        recordModelOutcome: async () => ({ accepted: true }),
      },
    });

    await service.invoke(request());

    const call = publish.mock.calls[0];
    if (call === undefined) {
      throw new Error("publish was not called");
    }
    const [, message] = call;
    const amount = JSON.parse((message as Record<string, string>).amount_json ?? "") as {
      usd: number;
    };
    // 2,000 tokens * 830 minor units, converted back through the same
    // (100 * 83) INR-paise divisor the fallback path shares -- $200, not
    // whatever the $0.00001/token fallback constant would have produced.
    expect(amount.usd).toBeCloseTo(200, 5);
  });

  it("rejects a response whose output_json is not a JSON object", async () => {
    const modelProvider = createMockModelProvider({
      invoke: async () => ({
        outputJson: JSON.stringify("just a string"),
        usageJson: JSON.stringify({ input_tokens: 1, output_tokens: 1 }),
        servedBy: "aws-bedrock",
      }),
    });
    const service = buildService({ modelProvider });

    await expect(service.invoke(request())).rejects.toThrow(
      /output_json must decode to a JSON object/,
    );
  });

  it("rejects a response whose usage_json does not conform to the shared usage contract", async () => {
    const modelProvider = createMockModelProvider({
      invoke: async () => ({
        outputJson: JSON.stringify({
          message: { role: "assistant", content: "hi" },
          stop_reason: "end_turn",
        }),
        usageJson: JSON.stringify({ totally: "wrong shape" }),
        servedBy: "aws-bedrock",
      }),
    });
    const service = buildService({ modelProvider });

    await expect(service.invoke(request())).rejects.toThrow(
      /usage_json does not conform/,
    );
  });

  it("never answers a call for one model with another model's cached answer", async () => {
    const invoke = vi.fn(createMockModelProvider().invoke);
    const service = buildService({
      modelProvider: createMockModelProvider({ invoke }),
      embeddingProvider: createMockEmbeddingProvider(),
      cacheProvider: createMockCacheProvider(),
    });

    const fast = await service.invoke(request({ model_alias: "FAST" }));
    const advanced = await service.invoke(request({ model_alias: "ADVANCED" }));

    expect([fast.cache_hit, advanced.cache_hit]).toEqual([false, false]);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("does not cache a payload whose content is all Alter's own fixed prompt", async () => {
    const mockCache = createMockCacheProvider();
    const setValue = vi.fn(mockCache.setValue);
    const cacheProvider = { ...mockCache, setValue };
    const service = buildService({
      embeddingProvider: createMockEmbeddingProvider(),
      cacheProvider,
    });

    await service.invoke(
      request({
        input_json: JSON.stringify({
          messages: [{ role: "system", content: "Fixed prompt.", alter_authored: true }],
        }),
      }),
    );

    expect(setValue).not.toHaveBeenCalled();
  });

  it("compares only what the caller varied, so one objective cannot answer another", async () => {
    // The fixed prompt is most of a planning payload. Comparing the whole
    // payload made two objectives near-identical text, and one was answered
    // with the other's cached response.
    const invoke = vi.fn(createMockModelProvider().invoke);
    const service = buildService({
      modelProvider: createMockModelProvider({ invoke }),
      cacheProvider: createMockCacheProvider(),
    });
    const fixed = "You are a task planner. " + "x".repeat(400);
    const plan = (objective: string) =>
      request({
        input_json: JSON.stringify({
          messages: [
            { role: "system", content: fixed, alter_authored: true },
            { role: "user", content: objective },
          ],
        }),
      });

    const first = await service.invoke(plan("count the pending orders"));
    const second = await service.invoke(plan("email the weekly status"));

    expect([first.cache_hit, second.cache_hit]).toEqual([false, false]);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  // C17 / design log §12: only an exact repeat is answered from the cache.
  // An embedding provider that scores every text as identical is the worst
  // case a similarity cache could meet -- under the 0.95 threshold it served
  // a one-word-different request with the first request's answer.
  it("never answers a near-identical request from the cache, however similar its embedding", async () => {
    const invoke = vi.fn(createMockModelProvider().invoke);
    const embed = vi.fn(async () => ({ vector: new Array(512).fill(0.1), modelId: "constant" }));
    const service = buildService({
      modelProvider: createMockModelProvider({ invoke }),
      embeddingProvider: { ...createMockEmbeddingProvider(), embed } as unknown as EmbeddingProvider,
      cacheProvider: createMockCacheProvider(),
    });
    const classify = (entity: string) =>
      request({
        input_json: JSON.stringify({
          messages: [{ role: "user", content: `Classify the risk of the ${entity} contract.` }],
        }),
      });

    const first = await service.invoke(classify("Acme"));
    const second = await service.invoke(classify("Apex"));
    const repeat = await service.invoke(classify("Acme"));

    expect([first.cache_hit, second.cache_hit, repeat.cache_hit]).toEqual([false, false, true]);
    expect(invoke).toHaveBeenCalledTimes(2);
    // The lookup is by key, so no embedding is spent on it.
    expect(embed).not.toHaveBeenCalled();
  });

  it("puts the model, the alias and the fixed prompt in the scope, not in the comparison", () => {
    const payload = (objective: string, fixedPrompt = "Fixed prompt.") =>
      JSON.stringify({
        messages: [
          { role: "system", content: fixedPrompt, alter_authored: true },
          { role: "user", content: objective },
        ],
        temperature: 0,
      });

    const first = cacheKey("nova-lite", "STANDARD", payload("count the orders"));
    const second = cacheKey("nova-lite", "STANDARD", payload("email the status"));
    const otherModel = cacheKey("nova-pro", "STANDARD", payload("count the orders"));
    const otherPrompt = cacheKey("nova-lite", "STANDARD", payload("count the orders", "Other."));

    // Same model and prompt: one scope, and the objectives are what differs.
    expect(second.scope).toBe(first.scope);
    expect(second.text).not.toBe(first.text);
    // A different model or a different fixed prompt can never serve this call.
    expect(otherModel.scope).not.toBe(first.scope);
    expect(otherPrompt.scope).not.toBe(first.scope);
    expect(otherModel.text).toBe(first.text);
  });

  it("has nothing to compare when every message is Alter's own fixed prompt", () => {
    const key = cacheKey(
      "nova-lite",
      "STANDARD",
      JSON.stringify({
        messages: [{ role: "system", content: "Fixed prompt.", alter_authored: true }],
      }),
    );

    expect(key.text).toBe("");
  });

  it("misses the cache on the first call, invokes the real model, then stores the result", async () => {
    const invoke = vi.fn(createMockModelProvider().invoke);
    const modelProvider = createMockModelProvider({ invoke });
    const mockCache = createMockCacheProvider();
    const setValue = vi.fn(mockCache.setValue);
    const service = buildService({ modelProvider, cacheProvider: { ...mockCache, setValue } });

    await service.invoke(request());

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(setValue).toHaveBeenCalledTimes(1);
    const [key, valueJson, ttlSeconds] = setValue.mock.calls[0]!;
    expect(key).toMatch(/^modelgw:exact:ten_018f47a2-7b11-7b11-8a11-1234567890ab:[0-9a-f]{64}$/);
    expect(ttlSeconds).toBe(24 * 60 * 60);
    const cachedValue = JSON.parse(valueJson);
    expect(cachedValue).toHaveProperty("output_json");
    expect(cachedValue).toHaveProperty("resolved_capability");
  });

  it("hits the cache on an identical second call and never invokes the real model again", async () => {
    const invoke = vi.fn(createMockModelProvider().invoke);
    const modelProvider = createMockModelProvider({ invoke });
    // Deterministic embedding: identical redacted text -> identical vector,
    // so the second call is guaranteed to be an exact cache hit.
    const embeddingProvider = createMockEmbeddingProvider();
    const cacheProvider = createMockCacheProvider();
    const service = buildService({
      modelProvider,
      embeddingProvider,
      cacheProvider,
    });

    const first = await service.invoke(request());
    const second = await service.invoke(request());

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(first.cache_hit).toBe(false);
    expect(second.cache_hit).toBe(true);
    expect(second).toEqual({ ...first, cache_hit: true });
  });

  it("does not cache-hit across different tenants even with identical input", async () => {
    const invoke = vi.fn(createMockModelProvider().invoke);
    const modelProvider = createMockModelProvider({ invoke });
    const cacheProvider = createMockCacheProvider();
    const service = buildService({ modelProvider, cacheProvider });

    await service.invoke(request({ tenant_id: "ten_tenant_a" }));
    await service.invoke(request({ tenant_id: "ten_tenant_b" }));

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("falls through to a real model call when the embedding provider fails (best-effort cache)", async () => {
    const invoke = vi.fn(createMockModelProvider().invoke);
    const modelProvider = createMockModelProvider({ invoke });
    const embeddingProvider: EmbeddingProvider = {
      ...createMockEmbeddingProvider(),
      embed: async () => {
        throw new Error("embedding provider unavailable");
      },
    };
    const service = buildService({ modelProvider, embeddingProvider });

    const response = await service.invoke(request());

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(response.resolved_capability).toBe("STANDARD:mock.model");
  });

  it("still returns a successful response when the cache store fails after a real invocation", async () => {
    const invoke = vi.fn(createMockModelProvider().invoke);
    const modelProvider = createMockModelProvider({ invoke });
    const cacheProvider: CacheProvider = {
      ...createMockCacheProvider(),
      setValue: async () => {
        throw new Error("cache unavailable");
      },
    };
    const service = buildService({ modelProvider, cacheProvider });

    const response = await service.invoke(request());

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(response.resolved_capability).toBe("STANDARD:mock.model");
  });

  it("ignores a corrupt cached value and falls through to a real model call", async () => {
    const invoke = vi.fn(createMockModelProvider().invoke);
    const modelProvider = createMockModelProvider({ invoke });
    const cacheProvider: CacheProvider = {
      ...createMockCacheProvider(),
      getValue: async () => "not-json{{{",
    };
    const service = buildService({ modelProvider, cacheProvider });

    const response = await service.invoke(request());

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(response.resolved_capability).toBe("STANDARD:mock.model");
  });

  // ENGINE-FIX-B5-19: stream() previously never checked or populated the
  // semantic cache at all -- every streaming call was a guaranteed miss.
  it("misses the cache on the first streaming call, then hits it on an identical second call without calling the model again", async () => {
    const stream = vi.fn(async function* () {
      yield { sequence: 1, delta: "hello ", final: false as const, servedBy: "mock.model" };
      yield { sequence: 2, delta: "world", final: false as const, servedBy: "mock.model" };
      yield {
        sequence: 3,
        delta: "",
        final: true as const,
        usageJson: JSON.stringify({ input_tokens: 4, output_tokens: 4 }),
        servedBy: "mock.model",
      };
    });
    const modelProvider = createMockModelProvider({ stream });
    // Deterministic embedding: identical redacted text -> identical vector,
    // so the second call is guaranteed to be an exact cache hit -- same
    // pattern as invoke()'s own cache-hit test above.
    const embeddingProvider = createMockEmbeddingProvider();
    const cacheProvider = createMockCacheProvider();
    const service = buildService({ modelProvider, embeddingProvider, cacheProvider });

    const firstChunks = [];
    for await (const chunk of service.stream(request())) {
      firstChunks.push(chunk);
    }
    const secondChunks = [];
    for await (const chunk of service.stream(request())) {
      secondChunks.push(chunk);
    }

    expect(stream).toHaveBeenCalledTimes(1);
    expect(firstChunks.map((chunk) => chunk.delta).join("")).toBe(
      "hello world",
    );
    // A cache hit is delivered as a single chunk carrying the full cached
    // content -- ModelgwStreamResponse's wire contract has no field to
    // reconstruct a cached value's original multi-chunk shape from, so there
    // is nothing to synthesize beyond one final chunk. Its usage is the usage
    // the original call reported, and so is its cost (#168): a replay is not
    // free to whoever accounts for it downstream.
    const originalCost = firstChunks.at(-1)?.estimated_cost_usd;
    expect(originalCost).not.toBe("");
    expect(secondChunks).toEqual([
      {
        sequence: 1,
        delta: "hello world",
        final: true,
        usage_json: JSON.stringify({ input_tokens: 4, output_tokens: 4 }),
        estimated_cost_usd: originalCost,
      },
    ]);
  });

  // #163: usage never reached the wire on a stream at all, so every consumer
  // of a streamed call saw no tokens -- which is how every real LLMTask node
  // came to record a NULL token_count.
  it("carries the terminal chunk's usage on the wire, and nothing on the others", async () => {
    const service = buildService({
      modelProvider: createMockModelProvider({
        stream: async function* () {
          yield { sequence: 1, delta: "hello ", final: false, servedBy: "mock.model" };
          yield {
            sequence: 2,
            delta: "world",
            final: true,
            usageJson: JSON.stringify({ input_tokens: 4, output_tokens: 9 }),
            servedBy: "mock.model",
          };
        },
      }),
    });

    const chunks = [];
    for await (const chunk of service.stream(request())) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.usage_json)).toEqual([
      "",
      JSON.stringify({ input_tokens: 4, output_tokens: 9 }),
    ]);
  });

  it("does not populate the cache when the stream errors partway through", async () => {
    const stream = vi.fn(async function* () {
      yield { sequence: 1, delta: "partial", final: false as const, servedBy: "mock.model" };
      throw new Error("upstream connection dropped");
    });
    const modelProvider = createMockModelProvider({ stream });
    const mockCache = createMockCacheProvider();
    const setValue = vi.fn(mockCache.setValue);
    const service = buildService({ modelProvider, cacheProvider: { ...mockCache, setValue } });

    const drain = async () => {
      const iterator = service.stream(request())[Symbol.asyncIterator]();
      while (!(await iterator.next()).done) {
        // Drain until the mid-stream error.
      }
    };
    await expect(drain()).rejects.toThrow(/upstream connection dropped/);

    expect(setValue).not.toHaveBeenCalled();

    // Behavioral confirmation, not just an empty store list: an identical
    // follow-up request must still miss and go upstream again -- if the
    // errored stream had cached the partial content, the mock's second call
    // (which also throws) would never have been reached.
    await expect(drain()).rejects.toThrow(/upstream connection dropped/);
    expect(stream).toHaveBeenCalledTimes(2);
  });
});

// #168: what a call cost, priced at the served model's own input and output
// rates. An unknown price must read as unknown -- never as free.
describe("ModelGatewayService reported call cost", () => {
  // Nova Micro's and Nova Pro's list rates, in US cents per token.
  const PRICES: Record<string, { input: string; output: string }> = {
    "apac.amazon.nova-micro-v1:0": { input: "0.0000035", output: "0.000014" },
    "apac.amazon.nova-pro-v1:0": { input: "0.00008", output: "0.00032" },
  };

  function pricedCostClient(
    resolved: Array<{ provider: string; resource: string; model_id: string }> = [],
  ): CostHandlerClient {
    return {
      ingestCostEvent: async () => ({ accepted: true }),
      recordModelOutcome: async () => ({ accepted: true }),
      resolveUnitPrice: async (lookup) => {
        resolved.push(lookup);
        const price = PRICES[lookup.model_id];
        if (price === undefined || lookup.resource === "tokens") {
          return { unit_cost_minor: "0", currency: "INR", confidence: "no_data" };
        }
        return {
          unit_cost_minor: lookup.resource === "input_tokens" ? price.input : price.output,
          currency: "USD",
          confidence: "fixed_table",
        };
      },
    };
  }

  function modelServing(
    modelId: string,
    usage: { input_tokens: number; output_tokens: number },
  ): ModelProvider {
    return createMockModelProvider({
      providerId: "aws-bedrock",
      invoke: async () => ({
        outputJson: JSON.stringify({ message: { role: "assistant", content: "ok" } }),
        usageJson: JSON.stringify(usage),
        servedBy: "aws-bedrock",
        servedModelId: modelId,
      }),
      stream: async function* () {
        yield { sequence: 1, delta: "ok", final: false as const, servedBy: "aws-bedrock" };
        yield {
          sequence: 2,
          delta: "",
          final: true as const,
          usageJson: JSON.stringify(usage),
          servedBy: "aws-bedrock",
          servedModelId: modelId,
        };
      },
    });
  }

  it("prices input and output tokens separately at the served model's rates", async () => {
    // 300 in, 200 out on Nova Pro: 300 * $0.0000008 + 200 * $0.0000032.
    const response = await buildService({
      modelProvider: modelServing("apac.amazon.nova-pro-v1:0", { input_tokens: 300, output_tokens: 200 }),
      costClient: pricedCostClient(),
    }).invoke(request());

    expect(response.estimated_cost_usd).toBe("0.00088");
  });

  it("separates two models that token count alone scores identically", async () => {
    const usage = { input_tokens: 300, output_tokens: 200 };
    const micro = await buildService({
      modelProvider: modelServing("apac.amazon.nova-micro-v1:0", usage),
      costClient: pricedCostClient(),
    }).invoke(request());
    const pro = await buildService({
      modelProvider: modelServing("apac.amazon.nova-pro-v1:0", usage),
      costClient: pricedCostClient(),
    }).invoke(request());

    expect(micro.estimated_cost_usd).toBe("0.0000385");
    expect(pro.estimated_cost_usd).toBe("0.00088");
  });

  it("reports an unpriced model as unknown, not as free", async () => {
    // Cost Ledger answers no_data with a unit price of "0". Passed through,
    // every call to this model would be reported as costing nothing.
    const response = await buildService({
      modelProvider: modelServing("some.unpriced-model", { input_tokens: 300, output_tokens: 200 }),
      costClient: pricedCostClient(),
    }).invoke(request());

    expect(response.estimated_cost_usd).toBe("");
  });

  it("reports cost as unknown when Cost Ledger cannot be reached, without failing the call", async () => {
    const response = await buildService({
      modelProvider: modelServing("apac.amazon.nova-pro-v1:0", { input_tokens: 300, output_tokens: 200 }),
      costClient: {
        ingestCostEvent: async () => ({ accepted: true }),
        recordModelOutcome: async () => ({ accepted: true }),
        resolveUnitPrice: async () => {
          throw new Error("cost ledger unavailable");
        },
      },
    }).invoke(request());

    expect(response.output_json).toContain("ok");
    expect(response.estimated_cost_usd).toBe("");
  });

  it("prices the model that actually served the call, not the alias's primary", async () => {
    // Under failover servedModelId is the fallback entry's model. Pricing the
    // alias's bound model instead would charge the wrong rate for the call.
    const resolved: Array<{ provider: string; resource: string; model_id: string }> = [];
    await buildService({
      modelProvider: modelServing("apac.amazon.nova-micro-v1:0", { input_tokens: 10, output_tokens: 10 }),
      costClient: pricedCostClient(resolved),
    }).invoke(request({ model_alias: "STANDARD" }));

    const modelLookups = resolved.filter((lookup) => lookup.resource !== "tokens");
    expect(modelLookups.map((lookup) => lookup.model_id)).toEqual([
      "apac.amazon.nova-micro-v1:0",
      "apac.amazon.nova-micro-v1:0",
    ]);
  });

  it("carries the cost on the final stream chunk only", async () => {
    const chunks = [];
    for await (const chunk of buildService({
      modelProvider: modelServing("apac.amazon.nova-pro-v1:0", { input_tokens: 300, output_tokens: 200 }),
      costClient: pricedCostClient(),
    }).stream(request())) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.estimated_cost_usd)).toEqual(["", "0.00088"]);
  });

  it("asks Cost Ledger once per model and direction, not on every call", async () => {
    const resolved: Array<{ provider: string; resource: string; model_id: string }> = [];
    const service = buildService({
      modelProvider: modelServing("apac.amazon.nova-pro-v1:0", { input_tokens: 1, output_tokens: 1 }),
      costClient: pricedCostClient(resolved),
      cacheProvider: createMockCacheProvider(),
    });

    await service.invoke(request({ input_json: JSON.stringify({ messages: [{ role: "user", content: "one" }] }) }));
    await service.invoke(request({ input_json: JSON.stringify({ messages: [{ role: "user", content: "two" }] }) }));

    expect(resolved.filter((lookup) => lookup.resource !== "tokens")).toHaveLength(2);
  });
});
