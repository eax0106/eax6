import type { ModelAlias } from "@alterx/contracts";
import type { ConfigProvider } from "@alterx/shared-clients";

import { PRIMARY_PRICING_PROVIDER, type ModelPolicyReader, type PricedModel } from "./worst-case-run-cost-estimator";

/** Reads the gateway's alias policy from the same config source the gateway uses. */
export class ConfigModelPolicy implements ModelPolicyReader {
  constructor(private readonly config: ConfigProvider) {}

  async modelsFor(alias: ModelAlias): Promise<readonly PricedModel[]> {
    const binding = await this.config.resolveModelAlias(alias);
    return [
      { provider: PRIMARY_PRICING_PROVIDER, modelId: binding.model_id },
      ...(binding.fallback_chain ?? []).map((fallback) => ({ provider: fallback.provider, modelId: fallback.model_id })),
    ];
  }

  async maxTokensPerCall(tenantId: string): Promise<number> {
    return (await this.config.resolveCostLimit({ tenantId, runId: "run_estimate" })).maxTokensPerCall;
  }
}
