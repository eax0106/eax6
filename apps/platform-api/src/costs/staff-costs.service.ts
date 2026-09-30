import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  ENGINE_CONFIG,
  ENGINE_M2M_TOKEN_PROVIDER,
  type EngineConfig,
  type EngineM2mTokenProvider,
} from "../engine";
import { parseRollup, parseSummaryQuery } from "./costs.service";
import { CostsHttpError } from "./problem";
import type { StaffCostSummary } from "./types";

const uuidV7 = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const tenantIdPattern = new RegExp(`^ten_${uuidV7}$`, "i");
const workspaceIdPattern = new RegExp(`^ws_${uuidV7}$`, "i");

/**
 * D24: the full cost breakdown (internal cost, retries, recovery, margin) is
 * staff-only. Staff hold no tenant session, so the ledger is read with
 * platform-api's service credential and the tenant named by the route; the
 * route itself is limited to billing operations staff.
 */
@Injectable()
export class StaffCostsService {
  constructor(
    @Inject(ENGINE_CONFIG) private readonly config: EngineConfig,
    @Inject(ENGINE_M2M_TOKEN_PROVIDER) private readonly m2m: EngineM2mTokenProvider,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async summary(tenantId: string, query: unknown): Promise<StaffCostSummary> {
    const instance = `/api/v1/admin/tenants/${tenantId}/costs`;
    if (!tenantIdPattern.test(tenantId)) {
      throw new CostsHttpError(400, "INVALID_COST_REQUEST", "tenantId must be a ten_ prefixed UUIDv7", instance);
    }
    const record = typeof query === "object" && query !== null ? (query as Record<string, unknown>) : {};
    const { workspaceId, ...rest } = record;
    if (typeof workspaceId !== "string" || !workspaceIdPattern.test(workspaceId)) {
      throw new CostsHttpError(400, "INVALID_COST_REQUEST", "workspaceId must be a ws_ prefixed UUIDv7", instance);
    }
    const parsed = parseSummaryQuery(rest, instance);
    let token: string;
    try {
      token = await this.m2m.getAccessToken();
    } catch {
      throw new CostsHttpError(502, "UPSTREAM_SERVICE_ERROR", "Cost ledger unavailable", instance);
    }
    const search = new URLSearchParams({ tenantId, workspaceId, startAt: parsed.startAt, endAt: parsed.endAt });
    for (const dimension of parsed.dimensions) search.append("dimensions", dimension);
    let body: unknown;
    try {
      const response = await this.fetchImpl(
        `${this.config.costLedgerBaseUrl.replace(/\/+$/, "")}/costs/summary?${search}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            traceparent: `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`,
            Accept: "application/json, application/problem+json",
          },
        },
      );
      if (!response.ok) throw new Error(`ledger answered ${response.status}`);
      body = await response.json();
    } catch {
      throw new CostsHttpError(502, "UPSTREAM_SERVICE_ERROR", "Cost ledger unavailable", instance);
    }
    const rollupsJson =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>).rollups_json : undefined;
    if (typeof rollupsJson !== "string") {
      throw new CostsHttpError(502, "INVALID_COST_ROLLUP_RESPONSE", "Cost ledger returned an invalid summary", instance);
    }
    const rollup = parseRollup(rollupsJson, instance);
    return {
      tenantId,
      workspaceId,
      startAt: rollup.start_at,
      endAt: rollup.end_at,
      currency: rollup.currency,
      dimensions: rollup.dimensions,
      groups: rollup.groups.map((group) => ({
        dimensions: group.dimensions,
        internalCostMinor: group.internal_cost_minor,
        retryCostMinor: group.retry_cost_minor,
        recoveryCostMinor: group.recovery_cost_minor,
        billableMinor: group.billable_minor,
        marginMinor: group.margin_minor,
        eventCount: group.event_count,
      })),
      totals: {
        internalCostMinor: rollup.totals.internal_cost_minor,
        billableMinor: rollup.totals.billable_minor,
        marginMinor: rollup.totals.margin_minor,
      },
    };
  }
}
