import { randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  CostLedgerClient,
  EngineClient,
  type EngineCallerContext,
} from "../engine";
import type { ActorContext } from "../rbac/types";
import { CostsHttpError } from "./problem";
import type { CostSummary, WorkflowCost } from "./types";

const allowedDimensions = ["mode", "source", "provider", "resource"] as const;

const MAX_WORKFLOW_COST_WINDOW_MS = 93 * 24 * 60 * 60 * 1000;
const RUN_PAGE_LIMIT = 200;
const MAX_RUN_PAGES = 50;
const workflowIdPattern =
  /^wf_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class CostsService {
  constructor(
    private readonly costs: CostLedgerClient,
    private readonly engine: EngineClient,
  ) {}

  /** D24: the tenant's costs over a window, billed price only. */
  async summary(
    query: unknown,
    actor: ActorContext | undefined,
    traceparent: string | undefined,
  ): Promise<CostSummary> {
    const instance = "/api/v1/costs/summary";
    const parsed = parseSummaryQuery(query, instance);
    const rollupsJson = await this.costs.getSummary(
      parsed,
      callerContext(actor, traceparent, instance),
    );
    return toTenantSummary(parseRollup(rollupsJson, instance));
  }

  /**
   * D24: what one workflow's runs started in the window cost the tenant, each
   * run billed on its own total. Runs are read newest first through the
   * caller's identity and kept only when they belong to the caller's
   * workspace.
   */
  async workflowCost(
    workflowId: string,
    query: unknown,
    actor: ActorContext | undefined,
    traceparent: string | undefined,
  ): Promise<WorkflowCost> {
    const instance = `/api/v1/workflows/${workflowId}/costs`;
    if (!workflowIdPattern.test(workflowId)) {
      throw invalidRequest(instance, "workflowId must be a wf_ prefixed UUIDv7");
    }
    const window = parseWindow(query, instance);
    if (Date.parse(window.endAt) - Date.parse(window.startAt) > MAX_WORKFLOW_COST_WINDOW_MS) {
      throw invalidRequest(instance, "the window may span at most 93 days");
    }
    const context = callerContext(actor, traceparent, instance);
    const startTime = Date.parse(window.startAt);
    const endTime = Date.parse(window.endAt);
    const workspace = bare(context.workspaceId, "ws");
    const runIds: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      if (pages === MAX_RUN_PAGES) {
        throw new CostsHttpError(422, "COST_WINDOW_TOO_LARGE", "Too many runs in the window; choose a shorter one", instance);
      }
      pages += 1;
      const page = await this.engine.get<EnginePage>(
        `/api/v1/runs?${new URLSearchParams({
          workflow_id: workflowId,
          limit: String(RUN_PAGE_LIMIT),
          ...(cursor === undefined ? {} : { cursor }),
        })}`,
        context,
      );
      const rows = Array.isArray(page.body?.data) ? page.body.data : [];
      let reachedStart = false;
      for (const row of rows) {
        const createdAt = typeof row.created_at === "string" ? Date.parse(row.created_at) : Number.NaN;
        if (Number.isNaN(createdAt) || typeof row.id !== "string") continue;
        if (createdAt < startTime) {
          reachedStart = true;
          break;
        }
        if (createdAt >= endTime) continue;
        if (typeof row.workspace_id !== "string" || bare(row.workspace_id, "ws") !== workspace) continue;
        runIds.push(row.id.startsWith("run_") ? row.id : `run_${row.id}`);
      }
      const next = page.body?.page?.next_cursor;
      if (reachedStart || page.body?.page?.has_more !== true || typeof next !== "string") break;
      cursor = next;
    }
    let billable = 0n;
    if (runIds.length > 0) {
      const totals = await this.costs.getRunTotals(runIds, context, instance);
      for (const runId of runIds) billable += BigInt(totals.get(runId) ?? "0");
    }
    return {
      workflowId,
      startAt: window.startAt,
      endAt: window.endAt,
      currency: "INR",
      billableMinor: billable.toString(),
      runCount: runIds.length,
    };
  }
}

interface EnginePage {
  readonly data?: readonly {
    readonly id?: unknown;
    readonly workspace_id?: unknown;
    readonly created_at?: unknown;
  }[];
  readonly page?: { readonly next_cursor?: unknown; readonly has_more?: unknown };
}

function bare(id: string, prefix: string): string {
  return id.startsWith(`${prefix}_`) ? id.slice(prefix.length + 1) : id;
}

/** Staff and tenant views share the ledger's rollup; only the staff view keeps every column. */
export function parseRollup(value: string, instance: string): RollupResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidUpstreamSummary(instance);
  }
  if (!isRollupResponse(parsed)) throw invalidUpstreamSummary(instance);
  return parsed;
}

function toTenantSummary(rollup: RollupResponse): CostSummary {
  return {
    startAt: rollup.start_at,
    endAt: rollup.end_at,
    currency: rollup.currency,
    dimensions: rollup.dimensions,
    groups: rollup.groups.map((group) => ({
      dimensions: group.dimensions,
      billableMinor: group.billable_minor,
      eventCount: group.event_count,
    })),
    totals: { billableMinor: rollup.totals.billable_minor },
  };
}

function parseWindow(value: unknown, instance: string): { startAt: string; endAt: string } {
  if (!isRecord(value)) throw invalidRequest(instance, "Query parameters required");
  const allowed = new Set(["startAt", "endAt"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw invalidRequest(instance, "only startAt and endAt are accepted");
  }
  const startAt = requiredString(value.startAt, instance, "startAt");
  const endAt = requiredString(value.endAt, instance, "endAt");
  const startTime = Date.parse(startAt);
  const endTime = Date.parse(endAt);
  if (Number.isNaN(startTime) || Number.isNaN(endTime) || endTime <= startTime) {
    throw invalidRequest(instance, "startAt and endAt must be ordered ISO 8601 timestamps");
  }
  return { startAt, endAt };
}

export function parseSummaryQuery(
  value: unknown,
  instance: string,
): { startAt: string; endAt: string; dimensions: string[] } {
  if (!isRecord(value)) throw invalidRequest(instance, "Query parameters required");
  const startAt = requiredString(value.startAt, instance, "startAt");
  const endAt = requiredString(value.endAt, instance, "endAt");
  const startTime = Date.parse(startAt);
  const endTime = Date.parse(endAt);
  if (Number.isNaN(startTime) || Number.isNaN(endTime) || endTime <= startTime) {
    throw invalidRequest(instance, "startAt and endAt must be ordered ISO 8601 timestamps");
  }
  const dimensions = value.dimensions === undefined
    ? []
    : Array.isArray(value.dimensions)
      ? value.dimensions
      : [value.dimensions];
  if (!dimensions.every(isDimension)) {
    throw invalidRequest(instance, "dimensions contains an unsupported value");
  }
  return { startAt, endAt, dimensions };
}

function callerContext(
  actor: ActorContext | undefined,
  traceparent: string | undefined,
  instance: string,
): EngineCallerContext {
  if (!actor) {
    throw new CostsHttpError(401, "AUTHENTICATION_REQUIRED", "Authenticated actor required", instance);
  }
  if (!actor.workspace_id) {
    throw new CostsHttpError(403, "COST_WORKSPACE_REQUIRED", "Workspace context required", instance);
  }
  return {
    userId: actor.user_id,
    tenantId: actor.tenant_id,
    workspaceId: actor.workspace_id,
    sessionId: actor.session_id,
    authTime: actor.auth_time ?? Math.floor(Date.now() / 1000),
    roles: actor.roles,
    permissions: actor.permissions,
    traceparent: validTraceparent(traceparent) ? traceparent : newTraceparent(),
  };
}

export interface RollupResponse {
  start_at: string;
  end_at: string;
  currency: "INR" | "USD";
  dimensions: string[];
  groups: Array<{
    dimensions: Record<string, string>;
    internal_cost_minor: string;
    retry_cost_minor: string;
    recovery_cost_minor: string;
    billable_minor: string;
    margin_minor: string;
    event_count: number;
  }>;
  totals: { internal_cost_minor: string; billable_minor: string; margin_minor: string };
}

function isRollupResponse(value: unknown): value is RollupResponse {
  return (
    isRecord(value) &&
    typeof value.start_at === "string" &&
    typeof value.end_at === "string" &&
    (value.currency === "INR" || value.currency === "USD") &&
    Array.isArray(value.dimensions) && value.dimensions.every(isDimension) &&
    Array.isArray(value.groups) && value.groups.every(isRollupGroup) &&
    isRollupTotals(value.totals)
  );
}

function isRollupGroup(value: unknown): boolean {
  return (
    isRecord(value) &&
    isStringRecord(value.dimensions) &&
    isMinor(value.internal_cost_minor) && isMinor(value.retry_cost_minor) &&
    isMinor(value.recovery_cost_minor) && isMinor(value.billable_minor) &&
    isMinor(value.margin_minor) &&
    typeof value.event_count === "number" && Number.isSafeInteger(value.event_count) && value.event_count >= 0
  );
}

function isRollupTotals(value: unknown): boolean {
  return isRecord(value) && isMinor(value.internal_cost_minor) && isMinor(value.billable_minor) && isMinor(value.margin_minor);
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isMinor(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function isDimension(value: unknown): value is (typeof allowedDimensions)[number] {
  return typeof value === "string" && allowedDimensions.includes(value as (typeof allowedDimensions)[number]);
}



function requiredString(value: unknown, instance: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw invalidRequest(instance, `${field} is required`);
  return value;
}

function invalidRequest(instance: string, detail: string): CostsHttpError {
  return new CostsHttpError(400, "INVALID_COST_REQUEST", detail, instance);
}

function invalidUpstreamSummary(instance: string): CostsHttpError {
  return new CostsHttpError(502, "INVALID_COST_ROLLUP_RESPONSE", "Cost ledger returned an invalid summary", instance);
}

function validTraceparent(value: string | undefined): value is string {
  return typeof value === "string" && /^00-[0-9a-f]{32}-[0-9a-f]{16}-[01]$/i.test(value);
}

function newTraceparent(): string {
  return `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
}
