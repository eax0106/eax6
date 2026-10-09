import { ModelInvocationPayloadSchema } from "@alterx/contracts";
import { readFileSync } from "node:fs";

export function localSmokePermitted(file: string, tenantId?: string, runId?: string): boolean {
  try {
    const permit = JSON.parse(readFileSync(file, "utf8"));
    return permit.gatewayPid === process.pid && permit.tenantId === tenantId
      && typeof permit.runId === "string" && permit.runId.startsWith("run_")
      && (runId === undefined || permit.runId === runId);
  } catch { return false; }
}

export const LOCAL_SMOKE_CEILING_USD = 0.25;
export const LOCAL_SMOKE_MAX_OUTPUT_TOKENS = 1024;
// Published Mumbai on-demand USD/token, checked 2026-10-06. The 1.5x
// margin also covers the priced cross-region inference profiles below.
// https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/ap-south-1/index.json
export const LOCAL_SMOKE_RATES: Readonly<Record<string, readonly [number, number]>> = {
  "global.amazon.nova-2-lite-v1:0": [0.00000035, 0.00000295],
  "apac.amazon.nova-lite-v1:0": [0.000000071, 0.000000284],
  "apac.amazon.nova-pro-v1:0": [0.00000094, 0.00000376],
};

/** Dedicated local stack only. Reserve worst-case spend before each paid
 * request, including failed attempts; never refund uncertain provider usage.
 * ponytail: one process budget, reset by an explicit stack restart only.
 */
export class LocalSmokeBudget {
  #reservedNanoUsd = 0;
  constructor(private readonly permitted: (tenantId?: string, runId?: string) => boolean = () => false) {}

  prepareInput(inputJson: string): string {
    const payload = ModelInvocationPayloadSchema.parse(JSON.parse(inputJson));
    return JSON.stringify({ ...payload,
      max_tokens: Math.min(payload.max_tokens ?? LOCAL_SMOKE_MAX_OUTPUT_TOKENS, LOCAL_SMOKE_MAX_OUTPUT_TOKENS) });
  }

  reserveModel(modelId: string, inputJson: string, fallbacks: readonly unknown[] = [], tenantId?: string, runId?: string): void {
    const rates = LOCAL_SMOKE_RATES[modelId];
    if (!rates || fallbacks.length) throw new Error("Local smoke refuses unpriced models or fallback chains");
    const payload = ModelInvocationPayloadSchema.parse(JSON.parse(inputJson));
    if (!payload.max_tokens || payload.max_tokens > LOCAL_SMOKE_MAX_OUTPUT_TOKENS) {
      throw new Error("Local smoke output token cap missing");
    }
    // A byte per input token is deliberately conservative for these text
    // models. Add 512 tokens for message framing rather than estimating words.
    this.#reserve((Buffer.byteLength(inputJson, "utf8") + 512) * rates[0] * 1.5
      + payload.max_tokens * rates[1] * 1.5, tenantId, runId);
  }

  reserveEmbedding(text: string, tenantId?: string): void {
    // Above the published Titan Text Embeddings V2 rate, including margin.
    this.#reserve((Buffer.byteLength(text, "utf8") + 512) * 0.00000015, tenantId);
  }

  #reserve(usd: number, tenantId?: string, runId?: string): void {
    if (!this.permitted(tenantId, runId)) throw new Error("Local smoke spend is not armed; no paid provider call started");
    const nanoUsd = Math.ceil(usd * 1e9);
    if (!Number.isSafeInteger(nanoUsd) || nanoUsd <= 0
      || this.#reservedNanoUsd + nanoUsd > LOCAL_SMOKE_CEILING_USD * 1e9) {
      throw new Error("Local smoke budget exhausted; no paid provider call started");
    }
    this.#reservedNanoUsd += nanoUsd;
  }
}
