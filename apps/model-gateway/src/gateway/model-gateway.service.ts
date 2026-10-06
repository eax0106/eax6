import { createHash } from "node:crypto";
import {
  ModelAliasSchema,
  ModelInvocationUsageSchema,
  type ModelgwEmbedRequest,
  type ModelgwEmbedResponse,
  type ModelgwInvokeRequest,
  type ModelgwInvokeResponse,
  type ModelgwRedactRequest,
  type ModelgwRedactResponse,
  type ModelgwStreamRequest,
  type ModelgwStreamResponse,
} from "@alterx/contracts";
import type { ModelgwHandler } from "@alterx/adapters";
import {
  InvalidModelAliasError,
  ModelGatewayCostLimitExceededError,
  ModelGatewayInvalidResponseError,
  type CacheProvider,
  type ConfigProvider,
  type EmbeddingDimensions,
  type EmbeddingProvider,
  type ModelProvider,
  type PIIRedactionProvider,
  type QueueProvider,
} from "@alterx/shared-clients";
import type { CostHandlerClient } from "@alterx/adapters";

import { costEventId } from "./cost-event-id";
import type { LocalSmokeBudget } from "./local-smoke-budget";

// Constant used as a last-resort fallback if Cost Ledger is unreachable.
const ESTIMATED_USD_PER_TOKEN = 0.00001;

// 1 USD = 83 INR
const FALLBACK_USD_TO_INR_RATE = 83;
const COST_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const CACHE_TTL_SECONDS = 24 * 60 * 60;

export class InvalidEmbeddingDimensionsError extends Error {
  constructor(dimensions: number) {
    super(`Embedding dimensions must be 512 or 1024, got ${dimensions}`);
    this.name = "InvalidEmbeddingDimensionsError";
  }
}

interface CachedInvokeValue {
  readonly output_json: string;
  readonly usage_json: string;
  readonly resolved_capability: string;
  readonly estimated_cost_usd?: string;
}

function parseCachedInvokeValue(
  valueJson: string,
): ModelgwInvokeResponse | undefined {
  try {
    const parsed = JSON.parse(valueJson) as Partial<CachedInvokeValue>;
    if (
      typeof parsed.output_json !== "string" ||
      typeof parsed.usage_json !== "string" ||
      typeof parsed.resolved_capability !== "string"
    ) {
      return undefined;
    }
    return {
      output_json: parsed.output_json,
      usage_json: parsed.usage_json,
      resolved_capability: parsed.resolved_capability,
      cache_hit: true,
      // Entries cached before #168 carry no cost. Unknown, not free.
      estimated_cost_usd:
        typeof parsed.estimated_cost_usd === "string" ? parsed.estimated_cost_usd : "",
    };
  } catch {
    return undefined;
  }
}

/**
 * A US-dollar amount as the wire carries it: a plain decimal, never exponent
 * notation. `String(1.75e-7)` is "1.75e-7", and a per-call model cost is
 * routinely that small. Twelve places is a trillionth of a dollar, far below
 * anything a price can distinguish.
 */
function usdDecimalString(amount: number): string {
  return amount.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
}

// ENGINE-FIX-B5-19: stream() has no equivalent of invoke()'s own output_json
// (a structured object) -- it only ever emits plain delta text fragments
// that concatenate into the assistant's reply. A cached ModelgwInvokeResponse
// still stores output_json in invoke()'s `{message: {role, content}, ...}`
// shape (see anthropic-model-provider.ts / bedrock-model-provider.ts /
// openai-model-provider.ts, all of which build that exact shape), so this
// extracts the plain text back out of it for replay as a single stream
// chunk. Returns undefined for anything not in the expected shape rather
// than guessing -- falls through to a real (uncached) stream in that case.
function extractCachedStreamText(outputJson: string): string | undefined {
  try {
    const parsed = JSON.parse(outputJson) as {
      readonly message?: { readonly content?: unknown };
    };
    return typeof parsed.message?.content === "string"
      ? parsed.message.content
      : undefined;
  } catch {
    return undefined;
  }
}

export class ModelGatewayService implements ModelgwHandler {
  readonly #unitPriceCache = new Map<string, { unitCostMinor: number; expireAt: number }>();
  readonly #modelPriceCache = new Map<string, { usdPerToken: number | undefined; expireAt: number }>();
  constructor(
    private readonly configProvider: ConfigProvider,
    private readonly modelProvider: ModelProvider,
    private readonly piiRedactionProvider: PIIRedactionProvider,
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly cacheProvider: CacheProvider,
    private readonly queueProvider: QueueProvider,
    private readonly costEventsQueueName: string,
    private readonly costClient: CostHandlerClient,
    private readonly localSmokeBudget?: Pick<LocalSmokeBudget, "prepareInput" | "reserveModel" | "reserveEmbedding">,
  ) {}


  /**
   * Redacts a model invocation payload WITHOUT destroying its JSON shape.
   *
   * The payload reaching this gateway is a serialized envelope
   * (`{ messages: [{ role, content }], ... }`). Redacting that whole string
   * as free text let a replacement span swallow structural characters --
   * an escaped quote, or the quotes around a URL -- leaving JSON that no
   * longer parses. The provider adapters call JSON.parse on this value, so
   * every payload containing a name or URL (i.e. most real ones) failed
   * with "Bad escaped character in JSON", surfacing far downstream as an
   * opaque node failure.
   *
   * Redacting each message's `content` instead scrubs exactly the operator
   * text while leaving the envelope intact. Behaviour is unchanged for any
   * payload this cannot parse: it falls back to redacting the whole string,
   * so a malformed envelope is never forwarded less-redacted than before.
   *
   * A system message marked `alter_authored: true` is fixed text Alter
   * wrote (see ModelMessageSchema) and is forwarded unredacted; the marker
   * is honoured on system messages only and removed from every message
   * before the payload leaves the gateway.
   */
  async #redactInvocationPayload(
    tenantId: string,
    inputJson: string,
  ): Promise<{ redactedText: string }> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(inputJson);
    } catch {
      const whole = await this.piiRedactionProvider.redact({ tenantId, text: inputJson });
      return { redactedText: whole.redactedText };
    }

    const payload = parsed as { messages?: unknown };
    if (!Array.isArray(payload.messages)) {
      const whole = await this.piiRedactionProvider.redact({ tenantId, text: inputJson });
      return { redactedText: whole.redactedText };
    }

    const messages = await Promise.all(
      payload.messages.map(async (message: unknown) => {
        if (typeof message !== "object" || message === null) return message;
        const { alter_authored: alterAuthored, ...record } = message as {
          alter_authored?: unknown;
          role?: unknown;
          content?: unknown;
        };
        if (typeof record.content !== "string") return record;
        if (record.role === "system" && alterAuthored === true) return record;
        const result = await this.piiRedactionProvider.redact({
          tenantId,
          text: record.content,
        });
        return { ...record, content: result.redactedText };
      }),
    );

    return { redactedText: JSON.stringify({ ...(parsed as object), messages }) };
  }

  async invoke(request: ModelgwInvokeRequest): Promise<ModelgwInvokeResponse> {
    const parsedAlias = ModelAliasSchema.safeParse(request.model_alias);
    if (!parsedAlias.success) {
      throw new InvalidModelAliasError(request.model_alias);
    }
    const alias = parsedAlias.data;

    const binding = await this.configProvider.resolveModelAlias(alias);
    // Every payload leaving this gateway toward a model provider is scrubbed
    // for PII first -- defense in depth even if a caller forgot to invoke
    // the standalone Redact RPC on the content itself. The semantic cache
    // below is keyed on this redacted text too, so a cache hit can never
    // leak PII that would not have left the gateway on a cache miss either.
    const redacted = await this.#redactInvocationPayload(
      request.tenant_id,
      request.input_json,
    );
    if (this.localSmokeBudget) redacted.redactedText = this.localSmokeBudget.prepareInput(redacted.redactedText);

    // Keyed once and reused for both the lookup and (on a miss) the store
    // below.
    const key = cacheKey(
      binding.model_id,
      alias,
      redacted.redactedText,
      alterAuthoredIndexes(request.input_json),
    );
    // Nothing the caller varied means nothing to compare: not cached.
    const entryKey = exactCacheEntryKey(request.tenant_id, key);

    const cacheHit = await this.#lookupCacheBestEffort(entryKey);
    if (cacheHit !== undefined) {
      return cacheHit;
    }

    let result: Awaited<ReturnType<ModelProvider["invoke"]>>;
    this.localSmokeBudget?.reserveModel(binding.model_id, redacted.redactedText, binding.fallback_chain, request.tenant_id, request.run_id);
    try {
      result = await this.modelProvider.invoke({
        tenantId: request.tenant_id,
        runId: request.run_id,
        nodeExecutionId: request.node_execution_id,
        modelId: binding.model_id,
        capabilityTags: binding.capability_tags,
        inputJson: redacted.redactedText,
        ...(binding.fallback_chain === undefined
          ? {}
          : { fallbackChain: binding.fallback_chain }),
      });
    } catch (error) {
      await this.#recordModelOutcomeBestEffort(request, binding.model_id, "failure");
      throw error;
    }

    // Validation floor: the response must be well-formed JSON that decodes
    // to an object (not a bare string/number/array/null). This is a shape
    // check, not a content check -- it catches a provider adapter returning
    // garbage, not a "wrong answer" from the model itself.
    this.#validateOutputShape(result.outputJson);

    const usage = this.#parseUsage(result.usageJson);
    this.#recordLocalSmokeUsage(request, result.servedModelId ?? binding.model_id, result.servedBy, usage);
    const totalTokens = usage.input_tokens + usage.output_tokens;
    
    const unitPriceMinor = await this.#resolveUnitPriceBestEffort(result.servedBy, "tokens");
    const estimatedCostUsd = (totalTokens * unitPriceMinor) / (100 * FALLBACK_USD_TO_INR_RATE);

    const limit = await this.configProvider.resolveCostLimit({
      tenantId: request.tenant_id,
      runId: request.run_id,
    });

    // The spend already happened by the time we can measure it -- emit the
    // cost event for what was actually used before deciding whether to
    // reject the call, so an over-limit call is never invisible to the
    // (future) Cost Ledger.
    await this.#emitCostEventBestEffort(
      request,
      result.servedBy,
      result.usageJson,
      estimatedCostUsd,
    );
    await this.#recordModelOutcomeBestEffort(request, result.servedBy, "success");

    if (totalTokens > limit.maxTokensPerCall) {
      throw new ModelGatewayCostLimitExceededError(
        `${totalTokens} tokens exceeds the resolved limit of ${limit.maxTokensPerCall} tokens for tenant ${request.tenant_id}`,
      );
    }
    if (estimatedCostUsd > limit.maxCostUsdPerCall) {
      throw new ModelGatewayCostLimitExceededError(
        `estimated $${estimatedCostUsd.toFixed(4)} exceeds the resolved limit of $${limit.maxCostUsdPerCall} for tenant ${request.tenant_id}`,
      );
    }

    const response: ModelgwInvokeResponse = {
      output_json: result.outputJson,
      usage_json: result.usageJson,
      // Always names both the alias tier resolved AND the concrete
      // provider that actually served it, e.g. "STANDARD:aws-bedrock" on
      // the normal path or "STANDARD:anthropic-direct" when GATE-3's
      // failover chain kicked in -- never a silent downgrade.
      resolved_capability: `${alias}:${result.servedBy}`,
      cache_hit: false,
      estimated_cost_usd: await this.#priceServedModelBestEffort(
        result.servedBy,
        result.servedModelId ?? binding.model_id,
        result.usageJson,
      ),
    };

    await this.#storeCacheBestEffort(entryKey, response);

    return response;
  }

  async *stream(
    request: ModelgwStreamRequest,
  ): AsyncIterable<ModelgwStreamResponse> {
    const parsedAlias = ModelAliasSchema.safeParse(request.model_alias);
    if (!parsedAlias.success) {
      throw new InvalidModelAliasError(request.model_alias);
    }
    const alias = parsedAlias.data;
    const binding = await this.configProvider.resolveModelAlias(alias);
    const redacted = await this.#redactInvocationPayload(
      request.tenant_id,
      request.input_json,
    );
    if (this.localSmokeBudget) redacted.redactedText = this.localSmokeBudget.prepareInput(redacted.redactedText);

    // ENGINE-FIX-B5-19: mirrors invoke()'s own key-once-then-check-cache
    // sequence above -- same reasons apply here (cache check before any
    // cost-limit resolution or real upstream call). On a
    // hit, invoke() never resolves a cost limit or touches the real model
    // provider at all; stream() does the same below, returning before
    // `resolveCostLimit` is even called.
    const key = cacheKey(
      binding.model_id,
      alias,
      redacted.redactedText,
      alterAuthoredIndexes(request.input_json),
    );
    // Nothing the caller varied means nothing to compare: not cached.
    const entryKey = exactCacheEntryKey(request.tenant_id, key);
    const cacheHit = await this.#lookupCacheBestEffort(entryKey);
    if (cacheHit !== undefined) {
      const cachedText = extractCachedStreamText(cacheHit.output_json);
      if (cachedText !== undefined) {
        // The cached entry carries the usage the original call reported, and
        // a replay costs the same tokens downstream accounting-wise as the
        // call it stands in for -- so it is passed through rather than
        // blanked, which would make a cache hit look free to every consumer.
        yield {
          sequence: 1,
          delta: cachedText,
          final: true,
          usage_json: cacheHit.usage_json,
          estimated_cost_usd: cacheHit.estimated_cost_usd,
        };
        return;
      }
      // Cached value isn't in the expected shape -- fall through to a real
      // stream rather than guessing at a delta to emit.
    }

    const limit = await this.configProvider.resolveCostLimit({
      tenantId: request.tenant_id,
      runId: request.run_id,
    });

    let expectedSequence = 1;
    let finalSeen = false;
    let servedBy: string | undefined;
    let accumulatedContent = "";
    let finalUsageJson: string | undefined;
    let finalCostUsd = "";
    this.localSmokeBudget?.reserveModel(binding.model_id, redacted.redactedText, binding.fallback_chain, request.tenant_id, request.run_id);
    try {
      for await (const chunk of this.modelProvider.stream({
        tenantId: request.tenant_id,
        runId: request.run_id,
        nodeExecutionId: request.node_execution_id,
        modelId: binding.model_id,
        capabilityTags: binding.capability_tags,
        inputJson: redacted.redactedText,
        ...(binding.fallback_chain === undefined
          ? {}
          : { fallbackChain: binding.fallback_chain }),
      })) {
        if (finalSeen) {
          throw new ModelGatewayInvalidResponseError(
            "model stream emitted data after its final chunk",
          );
        }
        if (chunk.sequence !== expectedSequence) {
          throw new ModelGatewayInvalidResponseError(
            `model stream expected sequence ${expectedSequence}, received ${chunk.sequence}`,
          );
        }
        expectedSequence += 1;
        if (servedBy !== undefined && chunk.servedBy !== servedBy) {
          throw new ModelGatewayInvalidResponseError(
            "model stream changed providers after emission began",
          );
        }
        servedBy = chunk.servedBy;
        accumulatedContent += chunk.delta;

        if (chunk.final) {
          finalSeen = true;
          finalUsageJson = chunk.usageJson;
          const usage = this.#parseUsage(chunk.usageJson);
          this.#recordLocalSmokeUsage(request, chunk.servedModelId ?? binding.model_id, chunk.servedBy, usage);
          const totalTokens = usage.input_tokens + usage.output_tokens;
          const unitPriceMinor = await this.#resolveUnitPriceBestEffort(chunk.servedBy, "tokens");
          const estimatedCostUsd = (totalTokens * unitPriceMinor) / (100 * FALLBACK_USD_TO_INR_RATE);

          await this.#emitCostEventBestEffort(
            request,
            chunk.servedBy,
            chunk.usageJson,
            estimatedCostUsd,
          );
          await this.#recordModelOutcomeBestEffort(request, chunk.servedBy, "success");
          if (totalTokens > limit.maxTokensPerCall) {
            throw new ModelGatewayCostLimitExceededError(
              `${totalTokens} tokens exceeds the resolved limit of ${limit.maxTokensPerCall} tokens for tenant ${request.tenant_id}`,
            );
          }
          if (estimatedCostUsd > limit.maxCostUsdPerCall) {
            throw new ModelGatewayCostLimitExceededError(
              `estimated $${estimatedCostUsd.toFixed(4)} exceeds the resolved limit of $${limit.maxCostUsdPerCall} for tenant ${request.tenant_id}`,
            );
          }
          finalCostUsd = await this.#priceServedModelBestEffort(
            chunk.servedBy,
            chunk.servedModelId ?? binding.model_id,
            chunk.usageJson,
          );
        }
        yield {
          sequence: chunk.sequence,
          delta: chunk.delta,
          final: chunk.final,
          // Only the final chunk has totals to report; the provider does not
          // know them before its stream ends.
          usage_json: chunk.final ? chunk.usageJson : "",
          estimated_cost_usd: chunk.final ? finalCostUsd : "",
        };
      }
      if (!finalSeen) {
        throw new ModelGatewayInvalidResponseError(
          "model stream ended without a final usage chunk",
        );
      }

      // ENGINE-FIX-B5-19: populate the cache only here -- past every throw
      // above (invalid-response errors, cost-limit rejections) and past the
      // final yield, so a partial/errored/cancelled stream never writes a
      // truncated response into the cache. Mirrors invoke()'s own
      // response-shape and #storeCacheBestEffort call at the end of its
      // cache-miss path.
      await this.#storeCacheBestEffort(entryKey, {
        output_json: JSON.stringify({
          message: { role: "assistant", content: accumulatedContent },
          stop_reason: "end_turn",
        }),
        usage_json:
          finalUsageJson ??
          JSON.stringify({ input_tokens: 0, output_tokens: 0 }),
        resolved_capability: `${alias}:${servedBy ?? binding.model_id}`,
        cache_hit: false,
        estimated_cost_usd: finalCostUsd,
      });
    } catch (error) {
      // A success outcome was already recorded above the moment the final
      // chunk arrived -- a later throw (e.g. a cost-limit rejection, or a
      // provider emitting data after its own final chunk) must not also
      // record a contradictory failure for the same real model call.
      if (!finalSeen) {
        await this.#recordModelOutcomeBestEffort(
          request,
          servedBy ?? binding.model_id,
          "failure",
        );
      }
      throw error;
    }
  }

  async redact(request: ModelgwRedactRequest): Promise<ModelgwRedactResponse> {
    const result = await this.piiRedactionProvider.redact({
      tenantId: request.tenant_id,
      text: request.content,
    });
    return {
      redacted_content: result.redactedText,
      redaction_count: result.entities.length,
    };
  }

  // Real transport for the embeddingProvider -- callers outside
  // model-gateway (e.g. ads-core's real chunk embedding, KNOW-5) reach it
  // here. This never swallows a failure: a caller asking for an embedding
  // needs to know if it didn't get one.
  async embed(request: ModelgwEmbedRequest): Promise<ModelgwEmbedResponse> {
    if (request.dimensions !== 512 && request.dimensions !== 1024) {
      throw new InvalidEmbeddingDimensionsError(request.dimensions);
    }
    const dimensions: EmbeddingDimensions = request.dimensions;
    this.localSmokeBudget?.reserveEmbedding(request.text, request.tenant_id);
    const result = await this.embeddingProvider.embed({
      tenantId: request.tenant_id,
      text: request.text,
      dimensions,
    });
    return {
      embedding: [...result.vector],
      dimensions: result.dimensions,
      model_id: result.modelId,
    };
  }

  #validateOutputShape(outputJson: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(outputJson);
    } catch {
      throw new ModelGatewayInvalidResponseError(
        "output_json is not valid JSON",
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new ModelGatewayInvalidResponseError(
        "output_json must decode to a JSON object",
      );
    }
  }

  #recordLocalSmokeUsage(
    request: ModelgwInvokeRequest | ModelgwStreamRequest,
    modelId: string,
    provider: string,
    usage: { input_tokens: number; output_tokens: number },
  ): void {
    if (this.localSmokeBudget) console.info(JSON.stringify({ localSmokeUsage: {
      runId: request.run_id, nodeExecutionId: request.node_execution_id, modelId, provider, ...usage,
    } }));
  }

  #parseUsage(usageJson: string) {
    const parsedResult = ModelInvocationUsageSchema.safeParse(
      (() => {
        try {
          return JSON.parse(usageJson);
        } catch {
          return undefined;
        }
      })(),
    );
    if (!parsedResult.success) {
      throw new ModelGatewayInvalidResponseError(
        "usage_json does not conform to the shared token-usage contract",
      );
    }
    return parsedResult.data;
  }

  async #resolveUnitPriceBestEffort(provider: string, resource: string): Promise<number> {
    const cacheKey = `${provider}:${resource}`;
    const cached = this.#unitPriceCache.get(cacheKey);
    if (cached !== undefined && Date.now() < cached.expireAt) {
      return cached.unitCostMinor;
    }

    try {
      // Provider-wide on purpose: this price drives cost-limit enforcement
      // and the amount billed, both unchanged by #168. The per-model price is
      // #priceServedModelBestEffort's, and reaches only the reported cost.
      const response = await this.costClient.resolveUnitPrice({ provider, resource, model_id: "" });
      // "0" with no_data is Cost Ledger saying it has no price, not that the
      // call was free. Taken literally it zeroes the estimate, and a $0
      // estimate can never exceed a cost limit -- the enforcement gap
      // ENGINE-FIX-B5-9 closed for outages. Unreachable while this client sent
      // no credential, because every lookup failed first; reachable the moment
      // it authenticates (#168). Unlike an outage this is a steady state, so
      // the fallback is cached for the TTL rather than re-asked and re-logged
      // on every call.
      const unitCostMinor =
        response.confidence === "no_data"
          ? ESTIMATED_USD_PER_TOKEN * 100 * FALLBACK_USD_TO_INR_RATE
          : Number(response.unit_cost_minor);
      
      this.#unitPriceCache.set(cacheKey, {
        unitCostMinor,
        expireAt: Date.now() + COST_CACHE_TTL_MS,
      });
      return unitCostMinor;
    } catch (error) {
      // Fail open: log loudly and fallback to the constant. ENGINE-FIX-B5-9:
      // do NOT round this -- unit_cost_minor is a per-token price, already a
      // small fraction (this expression evaluates to 0.083), and the real
      // Cost Ledger path already carries it at full fractional precision
      // (ResolveUnitPriceResponse.unit_cost_minor is a proto `string`
      // specifically so a decimal value survives the wire; see
      // estimation.service.ts's identical "decimal string, not integer"
      // convention). Math.round()-ing a sub-1 fraction to the nearest
      // integer here collapsed every fallback unit price to exactly 0,
      // which zeroed both the cost-limit comparison below (a $0 estimate
      // can never exceed a limit) and the amount recorded to Cost Ledger
      // for the whole outage window -- an enforcement gap and a billing
      // gap from the same rounding, in exactly the scenario (an outage)
      // where the fallback should be conservative, not silently zero.
      console.error(`Failed to resolve unit price for ${provider}/${resource}, falling back to constant`, error);
      return ESTIMATED_USD_PER_TOKEN * 100 * FALLBACK_USD_TO_INR_RATE;
    }
  }

  /**
   * What a call cost, priced at the served model's own input and output rates
   * (#168) -- reported to the caller, and not used for enforcement or billing.
   *
   * Deliberately stricter than #resolveUnitPriceBestEffort. Only a price read
   * from the fixed table counts. Cost Ledger answers "no_data" with a unit
   * price of "0", and a lookup failure falls back to a flat constant; either
   * would report a number that is not this model's price, and the first would
   * make every unpriced model look free to anyone summing what calls cost.
   * Anything short of a real price is reported as unknown ("").
   */
  async #priceServedModelBestEffort(
    provider: string,
    modelId: string,
    usageJson: string,
  ): Promise<string> {
    let usage: { readonly input_tokens: number; readonly output_tokens: number };
    try {
      usage = this.#parseUsage(usageJson);
    } catch {
      return "";
    }
    const [input, output] = await Promise.all([
      this.#modelTokenPriceUsdBestEffort(provider, modelId, "input_tokens"),
      this.#modelTokenPriceUsdBestEffort(provider, modelId, "output_tokens"),
    ]);
    if (input === undefined || output === undefined) return "";
    return usdDecimalString(usage.input_tokens * input + usage.output_tokens * output);
  }

  async #modelTokenPriceUsdBestEffort(
    provider: string,
    modelId: string,
    resource: "input_tokens" | "output_tokens",
  ): Promise<number | undefined> {
    const cacheKey = `${provider}:${modelId}:${resource}`;
    const cached = this.#modelPriceCache.get(cacheKey);
    if (cached !== undefined && Date.now() < cached.expireAt) {
      return cached.usdPerToken;
    }
    let usdPerToken: number | undefined;
    try {
      const response = await this.costClient.resolveUnitPrice({
        provider,
        resource,
        model_id: modelId,
      });
      const unitCostMinor = Number(response.unit_cost_minor);
      if (response.confidence === "fixed_table" && Number.isFinite(unitCostMinor)) {
        // unit_cost_minor is a minor unit per token: US cents for a USD row,
        // paise for an INR one, converted at the same rate cost events use.
        usdPerToken =
          response.currency === "USD"
            ? unitCostMinor / 100
            : unitCostMinor / (100 * FALLBACK_USD_TO_INR_RATE);
      }
    } catch (error) {
      console.error(`Failed to price ${modelId} ${resource} from Cost Ledger; reporting cost as unknown`, error);
      // Not cached: an outage should not pin "unknown" for a whole TTL.
      return undefined;
    }
    // A miss is cached too -- an unpriced model would otherwise cost two Cost
    // Ledger round trips on every call.
    this.#modelPriceCache.set(cacheKey, {
      usdPerToken,
      expireAt: Date.now() + COST_CACHE_TTL_MS,
    });
    return usdPerToken;
  }

  async #emitCostEventBestEffort(
    request: ModelgwInvokeRequest,
    providerReference: string,
    usageJson: string,
    estimatedCostUsd: number,
  ): Promise<void> {
    try {
      await this.queueProvider.publish(this.costEventsQueueName, {
        tenant_id: request.tenant_id,
        cost_event_id: costEventId(),
        run_id: request.run_id,
        node_execution_id: request.node_execution_id,
        provider_reference: providerReference,
        usage_json: usageJson,
        amount_json: JSON.stringify({
          usd: estimatedCostUsd,
          estimated: true,
        }),
        source: "model_gateway",
        occurred_at: new Date().toISOString(),
      });
    } catch {
      // Cost-event emission is best-effort: an unreachable or throttled
      // queue must never block returning an otherwise-successful model
      // response to the caller. The Cost Ledger will simply be missing
      // this event -- acceptable, unlike blocking the whole gateway.
    }
  }

  async #recordModelOutcomeBestEffort(
    request: ModelgwInvokeRequest | ModelgwStreamRequest,
    provider: string,
    verdict: "success" | "failure",
  ): Promise<void> {
    try {
      await this.costClient.recordModelOutcome({
        tenant_id: request.tenant_id,
        provider,
        resource: "tokens",
        verdict,
        run_id: request.run_id,
        node_execution_id: request.node_execution_id,
        recorded_at: new Date().toISOString(),
      });
    } catch {
      // Best-effort, mirrors #emitCostEventBestEffort: an unreachable Cost
      // Ledger must never block returning an otherwise-successful model
      // response, nor mask the real error on a failure path.
    }
  }

  async #lookupCacheBestEffort(
    entryKey: string | undefined,
  ): Promise<ModelgwInvokeResponse | undefined> {
    if (entryKey === undefined) {
      return undefined;
    }
    try {
      const valueJson = await this.cacheProvider.getValue(entryKey);
      if (valueJson === undefined) {
        return undefined;
      }
      return parseCachedInvokeValue(valueJson);
    } catch {
      // The cache is a pre-spend optimization, not a correctness
      // requirement -- any failure here (cache provider down, corrupt
      // cached value) must fall through to a real model invocation, never
      // fail the request.
      return undefined;
    }
  }

  async #storeCacheBestEffort(
    entryKey: string | undefined,
    response: ModelgwInvokeResponse,
  ): Promise<void> {
    if (entryKey === undefined) {
      return;
    }
    try {
      await this.cacheProvider.setValue(entryKey, JSON.stringify(response), CACHE_TTL_SECONDS);
    } catch {
      // Never fail an otherwise-successful model invocation because the
      // cache write failed.
    }
  }
}

/**
 * The cache answers only an exact repeat (task C17, design log §12).
 *
 * It used to compare embeddings and serve anything above 0.95 cosine
 * similarity. Two classification prompts differing by one entity name can
 * sit above that, so a near-identical call was answered with another call's
 * result -- the wrong answer, delivered quickly, and nobody had decided to
 * turn that on. The entry is now keyed by the tenant and a hash of the scope
 * and the caller's varying content together, so only byte-identical input
 * (after redaction) can hit, and no embedding call is spent on the lookup.
 */
export function exactCacheEntryKey(
  tenantId: string,
  key: { readonly scope: string; readonly text: string },
): string | undefined {
  if (key.text === "") return undefined;
  const digest = createHash("sha256").update(key.scope).update("\n").update(key.text).digest("hex");
  return `modelgw:exact:${tenantId}:${digest}`;
}

/**
 * What the cache compares, and what it must never compare across.
 *
 * The cache used to embed the whole payload and compare every candidate a
 * tenant had. Two different objectives sent with the same fixed prompt are
 * mostly identical text, so as prompts grew they scored above the similarity
 * threshold against each other and one objective was answered with another's
 * cached response. Nothing about similarity can fix that: the parts that must
 * match exactly belong in the scope, not in the comparison.
 *
 * So the scope pins the model (a cheap model's answer must not serve a call
 * that asked for a better one), the alias, and everything in the payload the
 * caller did not vary -- the messages marked `alter_authored`, which are
 * constant prompts Alter wrote, and the inference settings. `text` is only
 * the rest: the caller's own content, in order and with its roles. Since
 * C17 both must match exactly (`exactCacheEntryKey`).
 *
 * A payload with no varying content at all has nothing to compare, so it is
 * not cached: `text` is empty.
 */
export function cacheKey(
  modelId: string,
  alias: string,
  inputJson: string,
  fixedMessageIndexes: ReadonlySet<number> = new Set(),
): { readonly scope: string; readonly text: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch {
    return { scope: scopeHash({ modelId, alias }), text: inputJson };
  }
  const payload = parsed as {
    messages?: unknown;
    [key: string]: unknown;
  };
  if (!Array.isArray(payload.messages)) {
    return { scope: scopeHash({ modelId, alias }), text: inputJson };
  }
  const { messages, ...settings } = payload;
  const fixed: unknown[] = [];
  const varying: unknown[] = [];
  messages.forEach((message, index) => {
    const record = message as { role?: unknown; content?: unknown; alter_authored?: unknown };
    const isFixed =
      record.role === "system" &&
      (record.alter_authored === true || fixedMessageIndexes.has(index));
    (isFixed ? fixed : varying).push({ role: record.role, content: record.content });
  });
  return {
    scope: scopeHash({ modelId, alias, fixed, settings }),
    text: varying.length === 0 ? "" : JSON.stringify(varying),
  };
}

/**
 * Which messages the caller marked `alter_authored`, by position.
 *
 * Redaction strips the marker before a payload leaves the gateway (providers
 * never see it), and the cache key is built from the redacted payload so no
 * unredacted text reaches the cache either. Redaction keeps
 * the messages in place, so the positions still line up.
 */
export function alterAuthoredIndexes(inputJson: string): ReadonlySet<number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch {
    return new Set();
  }
  const messages = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return new Set();
  }
  const indexes = new Set<number>();
  messages.forEach((message, index) => {
    const record = message as { role?: unknown; alter_authored?: unknown };
    if (record.role === "system" && record.alter_authored === true) {
      indexes.add(index);
    }
  });
  return indexes;
}

function scopeHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}
