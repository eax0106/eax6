import type { ModelGatewayHandler } from "@alterx/adapters";
import type { ModelgwInvokeRequest, ModelgwInvokeResponse } from "@alterx/contracts";
import { ModelGatewayInvalidResponseError } from "@alterx/shared-clients";
import { describe, expect, it, vi } from "vitest";

import { NodeHandlerValidationError } from "../handler";
import { withSuccessCriteria, LlmTaskHandler, llmTaskSystemMessage, unwrapFencedJson } from "./llmtask.handler";

const TENANT_ID = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const RUN_ID = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const NODE_EXECUTION_ID = "node_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";

function fakeGateway(
  invoke: (request: ModelgwInvokeRequest) => Promise<ModelgwInvokeResponse>,
): ModelGatewayHandler {
  return { invoke };
}

interface FakeStreamChunk {
  readonly delta: string;
  readonly sequence: number;
  readonly final: boolean;
  readonly usage_json: string;
  readonly estimated_cost_usd?: string;
}

const streamOf = (...chunks: readonly FakeStreamChunk[]) =>
  vi.fn(async function* () {
    for (const chunk of chunks) yield chunk;
  });

function streamingGateway(
  stream: ReturnType<typeof streamOf>,
): ModelGatewayHandler & {
  stream(request: ModelgwInvokeRequest): AsyncIterable<FakeStreamChunk>;
} {
  return { invoke: vi.fn(), stream } as ModelGatewayHandler & {
    stream(request: ModelgwInvokeRequest): AsyncIterable<FakeStreamChunk>;
  };
}

describe("LlmTaskHandler agent instructions and output contract", () => {
  const run = async (extra: Record<string, unknown>, outputJson = JSON.stringify({ text: "hello" })) => {
    const invoke = vi.fn().mockResolvedValue({ output_json: outputJson, usage_json: "{}", resolved_capability: "" });
    const result = await new LlmTaskHandler(fakeGateway(invoke)).execute({
      config: { model_alias: "STANDARD", prompt: "Name the tool." },
      inputs: {},
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      node_execution_id: NODE_EXECUTION_ID,
      ...extra,
    });
    const messages = JSON.parse(invoke.mock.calls[0]![0].input_json).messages as { role: string; content: string }[];
    return { result, messages };
  };

  it("sends the bound agent's instructions as the system message, ahead of the output contract", async () => {
    const { messages } = await run({ agent_id: "agt_x", bound_agent_instructions: "Write every name in capitals." });

    expect(messages[0]).toEqual({ role: "system", content: "Write every name in capitals.\n\n" + llmTaskSystemMessage(undefined) });
    expect(messages[1]).toEqual({ role: "user", content: "Name the tool." });
  });

  it.each([["no agent bound", {}], ["an agent with no instructions", { bound_agent_instructions: "   " }]])(
    "still states the output contract with %s",
    async (_name, extra) => {
      const { messages } = await run(extra);
      expect(messages[0]).toEqual({ role: "system", content: llmTaskSystemMessage(undefined) });
      expect(messages[0]!.content).toMatch(/single JSON object only/);
    },
  );

  it("states the node's success criteria to the model, numbered, and nothing when there are none (C29)", () => {
    expect(withSuccessCriteria("Summarise.", ["Under 100 words", "Names the customer"])).toBe(
      "Summarise.\n\nYour output must meet every one of these success criteria:\n1. Under 100 words\n2. Names the customer",
    );
    expect(withSuccessCriteria("Summarise.", undefined)).toBe("Summarise.");
    expect(withSuccessCriteria("Summarise.", [])).toBe("Summarise.");
  });

  it("accepts a JSON answer wrapped in one markdown fence", async () => {
    const { result } = await run({}, "```json\n{\"name\": \"LOANDESK\"}\n```");
    expect(result.output).toEqual({ name: "LOANDESK" });
  });

  it("still rejects prose around a fenced answer", async () => {
    await expect(run({}, "Here you go:\n```json\n{\"name\": \"x\"}\n```")).rejects.toThrow(/not valid JSON/);
  });
});

describe("unwrapFencedJson", () => {
  it.each([
    ["```json\n{\"a\":1}\n```", "{\"a\":1}"],
    ["```\n{\"a\":1}\n```\n", "{\"a\":1}"],
    ["{\"a\":1}", "{\"a\":1}"],
    ["{\"code\":\"```\"}", "{\"code\":\"```\"}"],
  ])("%j -> %j", (input, expected) => {
    expect(unwrapFencedJson(input)).toBe(expected);
  });
});

describe("LlmTaskHandler", () => {
  it("has nodeType LLMTask", () => {
    const handler = new LlmTaskHandler(fakeGateway(vi.fn()));
    expect(handler.nodeType).toBe("LLMTask");
  });

  it("invokes the Model Gateway with the declared alias and run identifiers", async () => {
    const invoke = vi.fn().mockResolvedValue({
      output_json: JSON.stringify({ text: "hello" }),
      usage_json: JSON.stringify({ tokens: 42 }),
      resolved_capability: "anthropic.claude-sonnet-5",
    });
    const handler = new LlmTaskHandler(fakeGateway(invoke));

    const result = await handler.execute({
      config: { model_alias: "ADVANCED", prompt: "summarize this" },
      inputs: { node_a: { text: "upstream text" } },
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      node_execution_id: NODE_EXECUTION_ID,
    });

    expect(invoke).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      node_execution_id: NODE_EXECUTION_ID,
      model_alias: "ADVANCED",
      input_json: JSON.stringify({
        messages: [
          { role: "system", content: llmTaskSystemMessage(undefined) },
          {
            role: "user",
            content:
              "summarize this\n\nUpstream node output:\n" +
              JSON.stringify({ node_a: { text: "upstream text" } }, null, 2),
          },
        ],
      }),
    });
    expect(result.output).toEqual({ text: "hello" });
    expect(result.metadata).toEqual({
      usage: { tokens: 42 },
      resolved_capability: "anthropic.claude-sonnet-5",
    });
  });

  it("prefers a real Selection & Binding model_alias over the compiled config's alias", async () => {
    const invoke = vi.fn().mockResolvedValue({
      output_json: JSON.stringify({ text: "hello" }),
      usage_json: JSON.stringify({ tokens: 42 }),
      resolved_capability: "anthropic.claude-sonnet-5",
    });
    const handler = new LlmTaskHandler(fakeGateway(invoke));

    await handler.execute({
      config: { model_alias: "FAST", prompt: "summarize this" },
      inputs: {},
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      node_execution_id: NODE_EXECUTION_ID,
      bound_model_alias: "CEILING",
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ model_alias: "CEILING" }),
    );
  });

  it("includes the bound agent_id and tool_names in result metadata when a real binding matched", async () => {
    const invoke = vi.fn().mockResolvedValue({
      output_json: JSON.stringify({ text: "hello" }),
      usage_json: JSON.stringify({ tokens: 42 }),
      resolved_capability: "anthropic.claude-sonnet-5",
    });
    const handler = new LlmTaskHandler(fakeGateway(invoke));

    const result = await handler.execute({
      config: { model_alias: "ADVANCED", prompt: "summarize this" },
      inputs: {},
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      node_execution_id: NODE_EXECUTION_ID,
      agent_id: "agt_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
      bound_model_alias: "ADVANCED",
      bound_tool_names: ["search_web"],
    });

    expect(result.metadata).toEqual({
      usage: { tokens: 42 },
      resolved_capability: "anthropic.claude-sonnet-5",
      agent_id: "agt_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
      bound_tool_names: ["search_web"],
    });
  });

  it("forwards incremental model deltas before assembling the final output", async () => {
    const onModelDelta = vi.fn().mockResolvedValue(undefined);
    const stream = streamOf(
      { delta: '{"text":"hel', sequence: 1, final: false, usage_json: "" },
      {
        delta: 'lo"}',
        sequence: 2,
        final: true,
        usage_json: JSON.stringify({ input_tokens: 12, output_tokens: 34 }),
      },
    );
    const handler = new LlmTaskHandler(streamingGateway(stream));

    const result = await handler.execute({
      config: { model_alias: "ADVANCED", prompt: "summarize this" },
      inputs: {},
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      node_execution_id: NODE_EXECUTION_ID,
      on_model_delta: onModelDelta,
    });

    expect(stream).toHaveBeenCalledOnce();
    expect(onModelDelta.mock.calls).toEqual([
      ['{"text":"hel', 0, false],
      ['lo"}', 1, true],
    ]);
    expect(result.output).toEqual({ text: "hello" });
  });

  it("records the usage the final stream chunk reports", async () => {
    // The streaming branch is the one every real deployment takes -- the gRPC
    // client implements stream() -- and it used to drop usage entirely, so no
    // real run ever recorded a token_count and half of the binding efficiency
    // score was a constant (#163).
    const handler = new LlmTaskHandler(streamingGateway(streamOf(
      { delta: '{"ok":', sequence: 1, final: false, usage_json: "" },
      {
        delta: "true}",
        sequence: 2,
        final: true,
        usage_json: JSON.stringify({ input_tokens: 12, output_tokens: 34 }),
      },
    )));

    const result = await handler.execute({
      config: { model_alias: "ADVANCED", prompt: "summarize this" },
      inputs: {},
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      node_execution_id: NODE_EXECUTION_ID,
    });

    expect(result.metadata).toEqual({
      usage: { input_tokens: 12, output_tokens: 34 },
    });
  });

  it("records the cost the gateway priced on the final stream chunk", async () => {
    // #168: carried beside usage, so a node's metadata says what its model
    // call cost and not only how many tokens it used.
    const handler = new LlmTaskHandler(streamingGateway(streamOf(
      { delta: '{"ok":', sequence: 1, final: false, usage_json: "", estimated_cost_usd: "" },
      {
        delta: "true}",
        sequence: 2,
        final: true,
        usage_json: JSON.stringify({ input_tokens: 300, output_tokens: 200 }),
        estimated_cost_usd: "0.00088",
      },
    )));

    const result = await handler.execute({
      config: { model_alias: "ADVANCED", prompt: "summarize this" },
      inputs: {},
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      node_execution_id: NODE_EXECUTION_ID,
    });

    expect(result.metadata).toEqual({
      usage: { input_tokens: 300, output_tokens: 200 },
      estimated_cost_usd: "0.00088",
    });
  });

  it("leaves cost out entirely when the gateway had no price for the model", async () => {
    // Recorded as "0" it would read as free. Absent, it reads as what it is:
    // no price on record for that model.
    const handler = new LlmTaskHandler(streamingGateway(streamOf(
      {
        delta: '{"ok":true}',
        sequence: 1,
        final: true,
        usage_json: JSON.stringify({ input_tokens: 1, output_tokens: 1 }),
        estimated_cost_usd: "",
      },
    )));

    const result = await handler.execute({
      config: { model_alias: "ADVANCED", prompt: "summarize this" },
      inputs: {},
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      node_execution_id: NODE_EXECUTION_ID,
    });

    expect(result.metadata).not.toHaveProperty("estimated_cost_usd");
  });

  it("fails open on a malformed usage_json from a stream, keeping the output", async () => {
    const handler = new LlmTaskHandler(streamingGateway(streamOf(
      { delta: '{"ok":true}', sequence: 1, final: true, usage_json: "{not json" },
    )));

    const result = await handler.execute({
      config: { model_alias: "ADVANCED", prompt: "summarize this" },
      inputs: {},
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      node_execution_id: NODE_EXECUTION_ID,
    });

    expect(result.output).toEqual({ ok: true });
    expect(result.metadata).toEqual({ usage: {} });
  });

  it("rejects a missing model_alias", async () => {
    const handler = new LlmTaskHandler(fakeGateway(vi.fn()));

    await expect(
      handler.execute({
        config: { prompt: "x" },
        inputs: {},
        tenant_id: TENANT_ID,
        run_id: RUN_ID,
        node_execution_id: NODE_EXECUTION_ID,
      }),
    ).rejects.toThrow(NodeHandlerValidationError);
  });

  it("rejects an unrecognised model_alias", async () => {
    const handler = new LlmTaskHandler(fakeGateway(vi.fn()));

    await expect(
      handler.execute({
        config: { model_alias: "SUPER_FAST", prompt: "x" },
        inputs: {},
        tenant_id: TENANT_ID,
        run_id: RUN_ID,
        node_execution_id: NODE_EXECUTION_ID,
      }),
    ).rejects.toThrow(NodeHandlerValidationError);
  });

  it("rejects a missing prompt", async () => {
    const handler = new LlmTaskHandler(fakeGateway(vi.fn()));

    await expect(
      handler.execute({
        config: { model_alias: "FAST" },
        inputs: {},
        tenant_id: TENANT_ID,
        run_id: RUN_ID,
        node_execution_id: NODE_EXECUTION_ID,
      }),
    ).rejects.toThrow(NodeHandlerValidationError);
  });

  it("rejects a missing run context (tenant_id/run_id/node_execution_id)", async () => {
    const handler = new LlmTaskHandler(fakeGateway(vi.fn()));

    await expect(
      handler.execute({ config: { model_alias: "FAST", prompt: "x" }, inputs: {} }),
    ).rejects.toThrow(NodeHandlerValidationError);
  });

  it("fails closed on malformed output_json", async () => {
    const invoke = vi.fn().mockResolvedValue({
      output_json: "{not json",
      usage_json: "{}",
      resolved_capability: "x",
    });
    const handler = new LlmTaskHandler(fakeGateway(invoke));

    await expect(
      handler.execute({
        config: { model_alias: "FAST", prompt: "x" },
        inputs: {},
        tenant_id: TENANT_ID,
        run_id: RUN_ID,
        node_execution_id: NODE_EXECUTION_ID,
      }),
    ).rejects.toThrow(ModelGatewayInvalidResponseError);
  });

  it("fails closed when output_json parses to a non-object", async () => {
    const invoke = vi.fn().mockResolvedValue({
      output_json: "[1,2,3]",
      usage_json: "{}",
      resolved_capability: "x",
    });
    const handler = new LlmTaskHandler(fakeGateway(invoke));

    await expect(
      handler.execute({
        config: { model_alias: "FAST", prompt: "x" },
        inputs: {},
        tenant_id: TENANT_ID,
        run_id: RUN_ID,
        node_execution_id: NODE_EXECUTION_ID,
      }),
    ).rejects.toThrow(ModelGatewayInvalidResponseError);
  });

  it("fails open (empty usage) on malformed usage_json without losing the output", async () => {
    const invoke = vi.fn().mockResolvedValue({
      output_json: JSON.stringify({ text: "ok" }),
      usage_json: "{not json",
      resolved_capability: "x",
    });
    const handler = new LlmTaskHandler(fakeGateway(invoke));

    const result = await handler.execute({
      config: { model_alias: "FAST", prompt: "x" },
      inputs: {},
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      node_execution_id: NODE_EXECUTION_ID,
    });

    expect(result.output).toEqual({ text: "ok" });
    expect(result.metadata).toEqual({ usage: {}, resolved_capability: "x" });
  });
});
