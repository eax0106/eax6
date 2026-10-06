import { historyConfig } from "../benchmarks/history.client";
import type { TenantBenchmarksConfig } from "../tenant-benchmarks/tenant-benchmarks.service";

/** Customer benchmarks reach the same eval-service as the staff history, with the same credential. */
export function tenantBenchmarksConfig(environment: NodeJS.ProcessEnv = process.env): TenantBenchmarksConfig {
  const history = historyConfig(environment);
  return { baseUrl: history.baseUrl, tokenRef: history.tokenRef, timeoutMs: 15_000 };
}
