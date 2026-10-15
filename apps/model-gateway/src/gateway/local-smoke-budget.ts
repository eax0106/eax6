import { ModelInvocationPayloadSchema } from "@alterx/contracts";
import { readFileSync } from "node:fs";

// A UI session permit covers runs a signed-in user starts from the web app,
// which no script can name in advance. It still names the process and tenant,
// expires on its own, and spends from the same process-lifetime allowance.
export const LOCAL_UI_SESSION_MAX_MS = 2 * 60 * 60 * 1000;

export function localSmokePermitted(file: string, tenantId?: string, runId?: string, now = Date.now()): boolean {
  try {
    const permit = JSON.parse(readFileSync(file, "utf8"));
    if (permit.gatewayPid !== process.pid || permit.tenantId !== tenantId) return false;
    if (permit.runId === undefined && typeof permit.sessionUntil === "number") {
      return now < permit.sessionUntil && permit.sessionUntil - now <= LOCAL_UI_SESSION_MAX_MS
        && (runId === undefined || runId.startsWith("run_"));
    }
    return typeof permit.runId === "string" && permit.runId.startsWith("run_")
      && (runId === undefined || permit.runId === runId);
  } catch { return false; }
}

// The one place the local spend cap lives: mvp-stack, mvp-smoke and mvp-load
// read it from the built gateway. USD 1.00 covers the local MVP run.
export const LOCAL_SMOKE_CEILING_USD = 1;
// Planner skeletons for multi-step workflows can exceed 1024 tokens. The
// lifetime USD cap still reserves the full per-call upper bound before dispatch.
export const LOCAL_SMOKE_MAX_OUTPUT_TOKENS = 4096;
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
  constructor(
    private readonly permitted: (tenantId?: string, runId?: string) => boolean = () => false,
    private readonly ceilingUsd = LOCAL_SMOKE_CEILING_USD,
  ) {}

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
      || this.#reservedNanoUsd + nanoUsd > this.ceilingUsd * 1e9) {
      throw new Error("Local smoke budget exhausted; no paid provider call started");
    }
    this.#reservedNanoUsd += nanoUsd;
  }
}
