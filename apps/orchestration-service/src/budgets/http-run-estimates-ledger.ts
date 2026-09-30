import type { AccessTokenProvider } from "@alterx/auth";

import type { RunEstimatesLedger, ModelCallLine } from "./worst-case-run-cost-estimator";

/** Talks to the Cost Ledger's `POST /costs/worst-case` and `POST /costs/runs-average`. */
export class HttpRunEstimatesLedger implements RunEstimatesLedger {
  constructor(
    private readonly baseUrl: string,
    private readonly tokens: AccessTokenProvider,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async worstCase(input: { readonly tenantId: string; readonly lines: readonly ModelCallLine[] }) {
    const body = await this.post("worst-case", {
      tenantId: input.tenantId,
      lines: input.lines.map((line) => ({ models: line.models, maxTokens: line.maxTokens })),
    });
    return {
      billableMinor: wholeAmount(body["billable_minor"], "billable_minor"),
      unpricedLines: wholeAmount(body["unpriced_lines"], "unpriced_lines"),
    };
  }

  async runsAverage(input: { readonly tenantId: string; readonly workspaceId: string; readonly runIds: readonly string[] }) {
    const body = await this.post("runs-average", input);
    const average = body["average_billable_minor"];
    return {
      averageBillableMinor: average === null ? null : wholeAmount(average, "average_billable_minor"),
      runCount: wholeAmount(body["run_count"], "run_count"),
    };
  }

  private async post(route: string, payload: unknown): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}/costs/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await this.tokens.getAccessToken()}` },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Cost Ledger ${route} answered ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }
}

function wholeAmount(value: unknown, field: string): number {
  const amount = typeof value === "string" ? Number(value) : value;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) {
    throw new Error(`Cost Ledger ${field} was not a whole amount`);
  }
  return amount;
}
