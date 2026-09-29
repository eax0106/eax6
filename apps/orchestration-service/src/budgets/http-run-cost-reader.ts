import type { AccessTokenProvider } from "@alterx/auth";

import type { RunCostReader } from "./run-budget-gate";

/** Reads a run's billed total from the Cost Ledger's `/costs/run-total/:runId`. */
export class HttpRunCostReader implements RunCostReader {
  constructor(
    private readonly baseUrl: string,
    private readonly tokens: AccessTokenProvider,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async billableMinor(input: { readonly tenantId: string; readonly workspaceId: string; readonly runId: string }): Promise<number> {
    const query = new URLSearchParams({ tenantId: input.tenantId, workspaceId: input.workspaceId });
    const response = await this.fetchImpl(
      `${this.baseUrl.replace(/\/+$/, "")}/costs/run-total/${encodeURIComponent(input.runId)}?${query.toString()}`,
      { headers: { authorization: `Bearer ${await this.tokens.getAccessToken()}` } },
    );
    if (!response.ok) throw new Error(`Cost Ledger run total answered ${response.status}`);
    const body = (await response.json()) as { readonly billable_minor?: unknown };
    const minor = typeof body.billable_minor === "string" ? Number(body.billable_minor) : NaN;
    if (!Number.isSafeInteger(minor) || minor < 0) throw new Error("Cost Ledger run total was not a whole amount");
    return minor;
  }
}
