import { ModelAliasSchema, selectedModelAlias, type NodeType } from "@alterx/contracts";
import type { ModelGatewayHandler, ModelGatewayStreamHandler } from "@alterx/adapters";
import { ModelGatewayInvalidResponseError } from "@alterx/shared-clients";

import {
  NodeHandlerValidationError,
  type NodeExecutionContext,
  type NodeExecutionResult,
  type NodeHandler,
} from "../handler";

// Every LLMTask result is parsed as a JSON object, and planner prompts tell
// each step's author "the model executing this step will be told to respond
// with JSON only". Nothing told it: models wrapped answers in markdown fences
// and the node failed on its own output.
const OUTPUT_CONTRACT =
  "Respond with a single JSON object only: no prose before or after it, and no markdown code fences.";

/**
 * The system message for one LLMTask call: the bound agent's own instructions,
 * when an agent is bound and has any, then the engine's output contract, which
 * no agent instruction can remove.
 */
export function llmTaskSystemMessage(agentInstructions: string | undefined): string {
  const instructions = agentInstructions?.trim() ?? "";
  return instructions === "" ? OUTPUT_CONTRACT : `${instructions}\n\n${OUTPUT_CONTRACT}`;
}

/**
 * C29: the node's own success criteria, stated to the model it asks. The
 * Verification & Quality Gate judges the output against the same list, so the
 * producer and the judge read one contract.
 */
export function withSuccessCriteria(content: string, criteria: readonly string[] | undefined): string {
  if (criteria === undefined || criteria.length === 0) return content;
  const numbered = criteria.map((criterion, index) => `${index + 1}. ${criterion}`).join("\n");
  return `${content}\n\nYour output must meet every one of these success criteria:\n${numbered}`;
}

/**
 * The text inside one markdown code fence, when that fence is the entire
 * answer. Models still wrap JSON in ```json fences despite the output contract
 * (seen live on Bedrock); anything else passes through untouched and is parsed,
 * or rejected, exactly as before.
 */
export function unwrapFencedJson(text: string): string {
  const match = /^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/i.exec(text);
  return match === null ? text : match[1]!;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * LLMTask: routes through the Model Gateway (the ONLY LLM path -- adapter
 * law) using the node's declared config.model_alias. Never names a
 * concrete model; the Model Gateway resolves the alias via its own
 * versioned policy.
 */
export class LlmTaskHandler implements NodeHandler {
  readonly nodeType: NodeType = "LLMTask";

  constructor(private readonly modelGateway: ModelGatewayHandler) {}

  async execute(context: NodeExecutionContext): Promise<NodeExecutionResult> {
    // An explicit manual choice wins; automatic nodes keep runtime binding.
    const modelAlias = selectedModelAlias(context.config, context.bound_model_alias);
    const aliasResult = ModelAliasSchema.safeParse(modelAlias);
    if (!aliasResult.success) {
      throw new NodeHandlerValidationError(
        "LLMTask requires config.model_alias to be one of FAST, STANDARD, ADVANCED, CEILING",
      );
    }

    const prompt = context.config["prompt"];
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      throw new NodeHandlerValidationError(
        "LLMTask requires a non-empty config.prompt string",
      );
    }

    if (
      context.tenant_id === undefined ||
      context.run_id === undefined ||
      context.node_execution_id === undefined
    ) {
      throw new NodeHandlerValidationError(
        "LLMTask requires tenant_id, run_id, and node_execution_id on the execution context",
      );
    }

    // Upstream node output (context.inputs, keyed by producing node's key)
    // must reach the model -- without this, LLMTask only ever sees its own
    // static config.prompt and hallucinates whenever the prompt implies it
    // should act on a prior node's result (e.g. "summarise the search
    // results above"). Appended as JSON rather than invented into a
    // template/variable-substitution syntax the DAG contract doesn't
    // declare (see workflow-dag.ts) -- no node type currently supports
    // {{placeholder}} interpolation in config.prompt, so this stays a
    // fixed, always-present block instead of a partially-supported syntax.
    const upstreamEntries = Object.entries(context.inputs);
    const content = withSuccessCriteria(
      upstreamEntries.length === 0
        ? prompt
        : `${prompt}\n\nUpstream node output:\n${JSON.stringify(context.inputs, null, 2)}`,
      context.success_criteria,
    );

    const modelRequest = {
      tenant_id: context.tenant_id,
      run_id: context.run_id,
      node_execution_id: context.node_execution_id,
      model_alias: aliasResult.data,
      input_json: JSON.stringify({
        // The bound agent's instructions travel as the system message, so
        // binding a different agent changes how the node behaves -- not only
        // which record its cost and performance are attributed to.
        messages: [
          { role: "system", content: llmTaskSystemMessage(context.bound_agent_instructions) },
          { role: "user", content },
        ],
      }),
    };
    const streaming = this.modelGateway as ModelGatewayHandler & Partial<ModelGatewayStreamHandler>;
    let outputJson: string;
    let usage: unknown = {};
    let resolvedCapability: string | undefined;
    // Empty is the gateway's "no price on record for this model", and stays
    // out of metadata rather than being recorded as a cost of zero (#168).
    let estimatedCostUsd = "";
    if (streaming.stream !== undefined) {
      outputJson = "";
      for await (const chunk of streaming.stream(modelRequest)) {
        outputJson += chunk.delta;
        // Usage arrives on the final chunk only. Reading it is what gives the
        // performance record a token_count: this branch is the one every real
        // deployment takes, because the gRPC client implements stream(), so
        // while usage was dropped here no real run ever recorded a token
        // count and half of the binding efficiency score was a constant
        // (#163). Same fail-open parse as the invoke branch below -- usage is
        // metadata, and a malformed blob must not lose a valid output.
        if (chunk.final && chunk.usage_json !== "") {
          try { usage = JSON.parse(chunk.usage_json); } catch { usage = {}; }
        }
        if (chunk.final) estimatedCostUsd = chunk.estimated_cost_usd;
        await context.on_model_delta?.(chunk.delta, chunk.sequence - 1, chunk.final);
      }
    } else {
      const response = await this.modelGateway.invoke(modelRequest);
      outputJson = response.output_json;
      resolvedCapability = response.resolved_capability;
      estimatedCostUsd = response.estimated_cost_usd;
      try { usage = JSON.parse(response.usage_json); } catch { usage = {}; }
    }

    // output_json is the actual node result -- fail closed on malformed data,
    // never guess or pass through garbage.
    let parsedOutput: unknown;
    try {
      parsedOutput = JSON.parse(unwrapFencedJson(outputJson));
    } catch (error: unknown) {
      throw new ModelGatewayInvalidResponseError(
        `output_json is not valid JSON: ${(error as Error).message}`,
      );
    }
    if (!isPlainObject(parsedOutput)) {
      throw new ModelGatewayInvalidResponseError("output_json must parse to an object");
    }

    // usage_json is cost/observability metadata, not the task result itself --
    // fail open here (empty usage) rather than losing an otherwise-valid
    // output over a malformed metadata blob.
    return {
      output: parsedOutput,
      metadata: {
        usage,
        ...(estimatedCostUsd === "" ? {} : { estimated_cost_usd: estimatedCostUsd }),
        ...(resolvedCapability === undefined
          ? {}
          : { resolved_capability: resolvedCapability }),
        // Recorded for observability and the performance_records writer even
        // though this handler does not itself call Tool Gateway -- carries
        // the real bind result through, never fabricated.
        ...(context.agent_id === undefined ? {} : { agent_id: context.agent_id }),
        ...(context.bound_tool_names === undefined
          ? {}
          : { bound_tool_names: context.bound_tool_names }),
      },
    };
  }
}
