import { randomBytes } from "node:crypto";
import { EngineClient } from "../engine/engine-client";
import type { EngineCallerContext } from "../engine/types";
import type { PlatformDb } from "../signup/platform-db";
import type { ActorContext, RbacRequest } from "./types";

/**
 * Resolves the workspace that owns the resource a request addresses, so
 * RbacGuard can check a @RequireWorkspaceRole against THAT workspace
 * instead of the actor's any-workspace union (ENGINE-FIX-P5-1/P5-1b: an
 * admin of workspace A must not pass workspace B's admin gate just because
 * both sit in the same tenant).
 *
 * Returns:
 *   - a workspace id  -> guard checks the role against this workspace
 *   - undefined       -> route names no resolvable workspace; guard keeps
 *                        the legacy flat-role behavior for it (documented
 *                        limitation for collections and for families whose
 *                        ownership is enforced elsewhere -- see the
 *                        classification table in PR description)
 */
export interface ResourceWorkspaceResolver {
  resolveWorkspaceId(request: RbacRequest): Promise<string | undefined>;
}

export class WorkspaceLookupUnavailableError extends Error {
  constructor() {
    super("Workspace ownership could not be resolved");
    this.name = "WorkspaceLookupUnavailableError";
  }
}

export interface ResourceWorkspaceLookup {
  /** The resource's owning workspace, or undefined when no such resource
   * exists for the tenant ("doesn't exist" and "isn't yours" collapse).
   * Throws WorkspaceLookupUnavailableError when the backing system cannot
   * be consulted -- callers must fail closed on it. The lookup is made as
   * `actor`, the caller the guard is authorizing. */
  getWorkspaceId(actor: ActorContext, resourceId: string): Promise<string | undefined>;
}

const DEFAULT_POSITIVE_TTL_MS = 60 * 1000;
const DEFAULT_NEGATIVE_TTL_MS = 15 * 1000;

interface CacheEntry {
  readonly workspaceId: string | undefined;
  readonly expiresAtMs: number;
}

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Shared engine-backed lookup: one GET per resolution, positive results
 * cached 60s and negative 15s -- enough to keep repeat checks off the
 * engine without making a freshly-moved resource's old workspace sticky
 * for long. Lookup failures are NEVER cached -- an outage degrades to
 * fail-closed denials, not to stale grants. */
export class CachedEngineResourceLookup implements ResourceWorkspaceLookup {
  readonly #cache = new Map<string, CacheEntry>();
  readonly #engineClient: EngineClient;
  readonly #pathFor: (resourceId: string) => string;
  readonly #extract: (body: Record<string, unknown>) => string | undefined;
  readonly #now: () => number;

  constructor(
    engineClient: EngineClient,
    pathFor: (resourceId: string) => string,
    extract: (body: Record<string, unknown>) => string | undefined,
    now: () => number = () => Date.now(),
  ) {
    this.#engineClient = engineClient;
    this.#pathFor = pathFor;
    this.#extract = extract;
    this.#now = now;
  }

  async getWorkspaceId(actor: ActorContext, resourceId: string): Promise<string | undefined> {
    const tenantId = actor.tenant_id;
    const cacheKey = `${tenantId}:${this.#pathFor(resourceId)}`;
    const cached = this.#cache.get(cacheKey);
    const currentTime = this.#now();
    if (cached && cached.expiresAtMs > currentTime) {
      return cached.workspaceId;
    }

    // The engine authenticates every call with an actor token, and its
    // claims schema requires a real user, workspace and session. The lookup
    // used to send empty strings for them, which the engine rejected as
    // AUTH_INVALID_ACTOR_TOKEN, so every route whose workspace is resolved
    // through the engine was denied. It now reads as the caller. An actor
    // with no workspace at all cannot hold the workspace role these routes
    // require, so that case fails closed rather than calling the engine.
    if (!actor.workspace_id) {
      throw new WorkspaceLookupUnavailableError();
    }
    let status: number;
    let body: Record<string, unknown> | undefined;
    try {
      const context: EngineCallerContext = {
        userId: actor.user_id,
        tenantId,
        workspaceId: actor.workspace_id,
        sessionId: actor.session_id,
        authTime: actor.auth_time ?? Math.floor(currentTime / 1000),
        roles: actor.roles,
        permissions: actor.permissions,
        traceparent: `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`,
      };
      const response = await this.#engineClient.get<Record<string, unknown>>(
        this.#pathFor(encodeURIComponent(resourceId)) as `/api/v1/${string}`,
        context,
      );
      status = response.status;
      body = response.body;
    } catch (error: unknown) {
      void error;
      throw new WorkspaceLookupUnavailableError();
    }

    if (status === 404) {
      this.#cache.set(cacheKey, { workspaceId: undefined, expiresAtMs: currentTime + DEFAULT_NEGATIVE_TTL_MS });
      return undefined;
    }
    if (status !== 200) {
      throw new WorkspaceLookupUnavailableError();
    }
    const workspaceId = this.#extract(body ?? {});
    if (workspaceId === undefined) {
      throw new WorkspaceLookupUnavailableError();
    }
    this.#cache.set(cacheKey, { workspaceId, expiresAtMs: currentTime + DEFAULT_POSITIVE_TTL_MS });
    return workspaceId;
  }
}

/**
 * Reads the workspace off an engine response by either spelling of the
 * field, because the engine is not consistent about it: runs and the Action
 * Centre families answer `workspace_id`, while workflows, projects, triggers
 * and artifacts answer `workspaceId`. A lookup naming only one spelling
 * reads undefined for the other and fails closed -- which is how every
 * workflow and project id route came to answer 403 to the very workspace
 * that owns the resource.
 */
function workspaceField(field: string) {
  const spellings = [
    field,
    field.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
    field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
  ];
  return (body: Record<string, unknown>): string | undefined => {
    for (const spelling of spellings) {
      const value = body[spelling];
      if (typeof value === "string" && value.length > 0) return value;
    }
    return undefined;
  };
}

/** platform_db-backed lookup for oauth connection ids -- the rows live
 * locally, so a direct tenant-scoped query beats an HTTP round trip. Same
 * contract otherwise: not-found collapses to undefined, DB failure is
 * fail-closed, nothing cached. */
export class ConnectionWorkspaceLookup implements ResourceWorkspaceLookup {
  constructor(private readonly db: PlatformDb) {}

  async getWorkspaceId(actor: ActorContext, connectionId: string): Promise<string | undefined> {
    const tenantId = actor.tenant_id;
    if (!UUID_LIKE.test(connectionId)) {
      // Malformed ids can never be real connections; treat like missing.
      return undefined;
    }
    try {
      const rows = await this.db.queryTenant<{ readonly workspace_id: string }>(
        tenantId,
        "SELECT workspace_id FROM oauth_connections WHERE tenant_id = $1 AND id = $2",
        [tenantId, connectionId],
      );
      return rows[0]?.workspace_id;
    } catch (error: unknown) {
      void error;
      throw new WorkspaceLookupUnavailableError();
    }
  }
}

export interface WorkspaceResolutionRule {
  /** Route params this rule consumes; the first present wins. Bare `id`
   * entries MUST carry pathMarkers so they cannot capture unrelated
   * controllers' generic :id params. */
  readonly paramNames: readonly string[];
  /** When set, the request URL must contain at least one marker. */
  readonly pathMarkers?: readonly string[];
  /** Undefined = the param itself IS the workspace id (direct pass-through,
   * still validated downstream by membership lookup in the guard). */
  readonly lookup?: ResourceWorkspaceLookup;
  /** Annotation-style routes address their item through a sibling `type`
   * param naming which family owns the id. */
  readonly typeParamMapping?: Readonly<Record<string, ResourceWorkspaceLookup>>;
}

/**
 * Ordered rule registry: specific resource params first, ambiguous bare
 * `id` routes last behind path markers. Adding a resource type is one
 * entry here plus (when engine-owned) one additive workspace field on its
 * existing read response -- not a resolver rewrite.
 */
export class ParamWorkspaceResolver implements ResourceWorkspaceResolver {
  readonly #rules: readonly WorkspaceResolutionRule[];

  constructor(rules: readonly WorkspaceResolutionRule[] = []) {
    this.#rules = rules;
  }

  async resolveWorkspaceId(request: RbacRequest): Promise<string | undefined> {
    const params = request.params ?? {};
    const url = request.url ?? "";
    const actor = request.actorContext;

    for (const rule of this.#rules) {
      if (rule.pathMarkers && !rule.pathMarkers.some((marker) => url.includes(marker))) {
        continue;
      }
      const paramName = rule.paramNames.find((name) => {
        const value = params[name];
        return typeof value === "string" && value.length > 0;
      });
      if (paramName === undefined) {
        continue;
      }
      const rawValue = params[paramName] as string;

      if (rule.typeParamMapping) {
        const type = typeof params.type === "string" ? params.type.toLowerCase() : "";
        const lookup = rule.typeParamMapping[type];
        if (!lookup || !actor) return undefined;
        return lookup.getWorkspaceId(actor, rawValue);
      }
      if (rule.lookup === undefined) {
        // Direct pass-through: the addressed resource IS a workspace.
        return rawValue;
      }
      if (!actor) {
        return undefined;
      }
      return rule.lookup.getWorkspaceId(actor, rawValue);
    }
    return undefined;
  }
}

/** Production registry (EnforcingRbacModule). Order matters: specific
 * param families before the marker-gated bare-`id` fallbacks. */
/** The engine collection an Action Centre id belongs to, by its prefix. */
function actionCentreSegment(resourceId: string): string | undefined {
  if (resourceId.startsWith("apr_")) return "approvals";
  if (resourceId.startsWith("esc_")) return "escalations";
  if (resourceId.startsWith("clr_")) return "clarifications";
  return undefined;
}

export function defaultWorkspaceResolutionRules(deps: {
  readonly engineClient: EngineClient;
  readonly db: PlatformDb;
}): readonly WorkspaceResolutionRule[] {
  const { engineClient, db } = deps;
  const engine = (
    pathFor: (id: string) => string,
    field: string,
  ): ResourceWorkspaceLookup =>
    new CachedEngineResourceLookup(engineClient, pathFor, workspaceField(field));

  const approvalLike = (segment: string): ResourceWorkspaceLookup =>
    engine((id) => `/api/v1/${segment}/${id}`, "workspace_id");

  return [
    { paramNames: ["workspaceId", "workspace_id"] },
    { paramNames: ["projectId", "project_id"], lookup: engine((id) => `/api/v1/projects/${id}`, "workspace_id") },
    { paramNames: ["workflowId", "workflow_id"], lookup: engine((id) => `/api/v1/workflows/${id}`, "workspace_id") },
    { paramNames: ["runId", "run_id"], lookup: approvalLike("runs") },
    // ENGINE-FIX-B5-1: artifacts.workspaceId is joined from runs.workspace_id
    // (see artifacts.service.ts) -- camelCase field name because the
    // artifacts response, unlike runs'/workflows', was never snake_cased.
    { paramNames: ["artifactId", "artifact_id"], lookup: engine((id) => `/api/v1/artifacts/${id}`, "workspaceId") },
    { paramNames: ["triggerId", "trigger_id"], lookup: engine((id) => `/api/v1/triggers/${id}`, "workspaceId") },
    { paramNames: ["eventId", "event_id"], lookup: engine((id) => `/api/v1/events/${id}`, "workspace_id") },
    // The Action Centre addresses an item of any family by its own id; the
    // prefix says which engine collection owns it.
    {
      paramNames: ["actionId"],
      pathMarkers: ["/action-centre/"],
      lookup: {
        async getWorkspaceId(actor, resourceId) {
          const segment = actionCentreSegment(resourceId);
          return segment === undefined
            ? undefined
            : approvalLike(segment).getWorkspaceId(actor, resourceId);
        },
      },
    },
    { paramNames: ["approvalId", "approval_id"], lookup: approvalLike("approvals") },
    { paramNames: ["escalationId", "escalation_id"], lookup: approvalLike("escalations") },
    { paramNames: ["clarificationId", "clarification_id"], lookup: approvalLike("clarifications") },
    { paramNames: ["connectionId", "connection_id", "integrationId", "integration_id"], lookup: new ConnectionWorkspaceLookup(db) },
    // ENGINE-FIX-B5-2: ads-core's Source/Document/IngestionJob rows don't
    // store workspace_id directly (only scope_id / source_id -- see
    // ads-core's db/models.py) -- these hit dedicated ads-core routes that
    // resolve the join server-side. sourceId/documentId use a minimal,
    // RBAC-resolution-only read (their /permissions routes return `null`
    // for a real-but-unset resource, which would fail-closed the lookup);
    // jobId reuses the existing GET /ingestion/jobs/{id} route's now-additive
    // workspace_id field.
    { paramNames: ["sourceId", "source_id"], lookup: engine((id) => `/api/v1/ads/sources/${id}`, "workspace_id") },
    { paramNames: ["documentId", "document_id"], lookup: engine((id) => `/api/v1/ads/documents/${id}`, "workspace_id") },
    { paramNames: ["jobId", "job_id"], lookup: engine((id) => `/api/v1/ads/ingestion/jobs/${id}`, "workspace_id") },
    {
      // Annotation items: /api/v1/action-items/:type/:id/annotations --
      // the id belongs to whichever family the sibling type param names.
      paramNames: ["id"],
      pathMarkers: ["/action-items/"],
      typeParamMapping: {
        approval: approvalLike("approvals"),
        escalation: approvalLike("escalations"),
        clarification: approvalLike("clarifications"),
      },
    },
    {
      // Triggers address their resource as a bare :id.
      paramNames: ["id"],
      pathMarkers: ["/triggers/"],
      lookup: engine((id) => `/api/v1/triggers/${id}`, "workspaceId"),
    },
  ];
}

/** Legacy composition default (plain RbacModule): no rules -> every route
 * unbound -> the guard keeps the documented flat-role behavior. */
export function legacyFlatRules(): readonly WorkspaceResolutionRule[] {
  return [];
}
