import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  type RouteConfig,
} from "@asteasolutions/zod-to-openapi";
import { CanonicalEventSchema } from "./canonical-event";
import { ActorTokenClaimsSchema } from "./actor-token";
import {
  AdsRetrievalRequestSchema,
  AdsRetrievalResponseSchema,
} from "./ads-retrieval";
import {
  AdsIngestionJobSchema,
  AdsUploadCompleteRequestSchema,
  AdsUploadStartRequestSchema,
  AdsUploadStartResponseSchema,
} from "./ads-ingestion";
import { AdsSourcePermissionsSchema } from "./ads-permissions";
import {
  ClarificationIdSchema,
  ProjectIdSchema,
  RequestIdSchema,
  RunIdSchema,
  TraceIdSchema,
  WorkflowIdSchema,
} from "./ids";
import { ProblemDetailsSchema } from "./problem-details";
import { ProviderCapabilitiesSchema } from "./provider-capabilities";
import { SseEnvelopeSchema } from "./sse";
import { SignedReferenceSchema } from "./signed-reference";
import {
  PromoteVersionResultSchema,
  RollbackVersionResultSchema,
  StartCanaryResultSchema,
  TestVersionRequestSchema,
  TestVersionResultSchema,
} from "./deployment";
import {
  RegisterTriggerResultSchema,
  TriggerListResultSchema,
  TriggerSchema,
  TriggerVersionSchema,
} from "./triggers";
import {
  CreateTriggerBindingRequestSchema,
  RotateWebhookSecretResultSchema,
  TriggerBindingListSchema,
  TriggerBindingSchema,
  WebhookEndpointSchema,
} from "./trigger-bindings";
import {
  NodeRequirementsSchema,
  NodeTypeSchema,
  PolicyBindingsSchema,
  WorkflowDagCompiledSchema,
  WorkflowDagDraftSchema,
} from "./workflow-dag";
import { z } from "./zod";
import { NodeOverrideRequestSchema, NodeOverrideComparisonSchema } from "./node-overrides";

const NodeOverrideOptionsSchema = z.object({ can_edit: z.boolean() }).strict();

type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export interface V1RouteSpec {
  readonly method: HttpMethod;
  readonly path: string;
  readonly summary: string;
  readonly tag: string;
  readonly collection?: boolean;
  readonly statusFilter?: boolean;
  readonly runsFilter?: boolean;
  readonly sse?: boolean;
  readonly successStatus?: 200 | 201 | 202;
  readonly idempotent?: boolean;
  // Typed response override, replacing the generic opaque Resource (or,
  // for a collection route, the generic cursor-paginated envelope) with a
  // real, registered schema. Registered once in createOpenApiDocument()
  // and looked up by raw-schema identity, since the same schema object is
  // often reused across several routes.
  readonly responseSchema?: z.ZodTypeAny;
  // Explicit management DTOs are only added when an operation has a real
  // contract. Generic Resource is retained for legacy routes still awaiting
  // their implementation tickets.
  readonly requestBodySchema?: z.ZodTypeAny;
  // Query params for a route that isn't a cursor-paginated `collection`
  // (Trigger Registry's real list route accepts an optional workflowId
  // filter but has no pagination at all -- see TriggerListResultSchema).
  readonly queryParams?: z.ZodObject<z.ZodRawShape>;
}

// Matches trigger-registry.controller.ts's real @Query("workflowId") --
// camelCase, matching this route's overall camelCase wire format (see
// triggers.ts). Not a collection route (no pagination at all in the real
// listTriggers()), so this doesn't extend CursorQuerySchema. Declared
// before V1_ROUTE_SPECS since that array references it directly.
const TriggerListQuerySchema = z.object({
  workflowId: WorkflowIdSchema.optional(),
});

export type AlterOpenApiDocument = ReturnType<
  OpenApiGeneratorV31["generateDocument"]
> & {
  jsonSchemaDialect: string;
};

export const V1_ROUTE_SPECS: readonly V1RouteSpec[] = [
  { method: "post", path: "/workflows", summary: "Create workflow", tag: "Workflows", successStatus: 201 },
  { method: "get", path: "/workflows", summary: "List workflows", tag: "Workflows", collection: true },
  { method: "get", path: "/workflows/{id}", summary: "Get workflow", tag: "Workflows" },
  { method: "get", path: "/workflows/{id}/node-overrides", summary: "Get node editing rights", tag: "Workflows", responseSchema: NodeOverrideOptionsSchema },
  { method: "post", path: "/workflows/{id}/node-overrides/compare", summary: "Compare a manual node choice against recorded selection", tag: "Workflows", successStatus: 200, idempotent: true, requestBodySchema: NodeOverrideRequestSchema, responseSchema: NodeOverrideComparisonSchema },
  { method: "patch", path: "/workflows/{id}", summary: "Update workflow", tag: "Workflows" },
  { method: "get", path: "/workflows/{id}/versions", summary: "List workflow versions", tag: "Workflows", collection: true },
  { method: "post", path: "/workflows/{id}/actions/compile", summary: "Compile workflow", tag: "Workflows", successStatus: 202 },
  { method: "post", path: "/workflows/{id}/actions/simulate", summary: "Simulate workflow", tag: "Workflows" },
  { method: "post", path: "/workflows/{id}/actions/activate", summary: "Activate workflow", tag: "Workflows" },
  { method: "post", path: "/workflows/{id}/actions/pause", summary: "Pause workflow", tag: "Workflows" },
  { method: "post", path: "/workflows/{id}/actions/resume", summary: "Resume workflow", tag: "Workflows" },
  {
    method: "post",
    path: "/workflows/{id}/actions/rollback",
    summary: "Roll back workflow",
    tag: "Workflows",
    responseSchema: RollbackVersionResultSchema,
  },
  {
    method: "post",
    path: "/workflows/{id}/actions/test-version",
    summary: "Test workflow version",
    tag: "Workflows",
    requestBodySchema: TestVersionRequestSchema,
    responseSchema: TestVersionResultSchema,
  },
  {
    method: "post",
    path: "/workflows/{id}/actions/promote-version",
    summary: "Promote workflow version",
    tag: "Workflows",
    responseSchema: PromoteVersionResultSchema,
  },
  {
    method: "post",
    path: "/workflows/{id}/actions/start-canary",
    summary: "Start workflow version canary",
    tag: "Workflows",
    responseSchema: StartCanaryResultSchema,
  },

  { method: "post", path: "/projects", summary: "Create project", tag: "Projects", successStatus: 201 },
  { method: "get", path: "/projects", summary: "List projects", tag: "Projects", collection: true },
  { method: "get", path: "/projects/{id}", summary: "Get project", tag: "Projects" },
  { method: "get", path: "/projects/{id}/versions", summary: "List project versions", tag: "Projects", collection: true },
  { method: "get", path: "/projects/{id}/repository", summary: "Get repository binding", tag: "Projects" },
  { method: "post", path: "/projects/{id}/builds", summary: "Start project build", tag: "Projects", successStatus: 202 },
  { method: "get", path: "/projects/{id}/builds", summary: "List project builds", tag: "Projects", collection: true },
  { method: "get", path: "/projects/{id}/tests", summary: "Get project test reports", tag: "Projects", collection: true },
  { method: "get", path: "/projects/{id}/audit-results", summary: "Get project audit results", tag: "Projects", collection: true },
  { method: "get", path: "/projects/{id}/previews", summary: "List project previews", tag: "Projects", collection: true },
  { method: "get", path: "/projects/{id}/deployments", summary: "List project deployments", tag: "Projects", collection: true },
  { method: "post", path: "/projects/{id}/actions/deploy", summary: "Deploy project", tag: "Projects", successStatus: 202 },
  { method: "post", path: "/projects/{id}/actions/rollback", summary: "Roll back project deployment", tag: "Projects" },

  { method: "post", path: "/runs", summary: "Start run", tag: "Runs", successStatus: 202 },
  { method: "get", path: "/runs", summary: "List runs", tag: "Runs", collection: true, runsFilter: true },
  { method: "get", path: "/runs/{id}", summary: "Get run", tag: "Runs" },
  { method: "get", path: "/runs/{id}/stream", summary: "Stream run events", tag: "Runs", sse: true },
  { method: "get", path: "/runs/{id}/node-executions", summary: "List node executions", tag: "Runs", collection: true },
  { method: "get", path: "/runs/{id}/verification-results", summary: "List verification results", tag: "Runs", collection: true },
  { method: "get", path: "/runs/{id}/recovery-actions", summary: "List recovery actions", tag: "Runs", collection: true },
  { method: "get", path: "/runs/{id}/quality-gates", summary: "List quality gates", tag: "Runs", collection: true },
  { method: "get", path: "/runs/{id}/outcome", summary: "Get run outcome", tag: "Runs" },
  { method: "post", path: "/runs/{id}/actions/cancel", summary: "Cancel run", tag: "Runs" },
  { method: "post", path: "/runs/{id}/actions/retry-node", summary: "Retry run node", tag: "Runs", successStatus: 202 },
  { method: "post", path: "/runs/{id}/clarifications/{cid}/answer", summary: "Answer clarification", tag: "Runs" },

  // Typed against trigger-registry.controller.ts's REAL routes/response
  // shapes (see triggers.ts's file-level comment on the camelCase wire
  // format). The 3 routes below (enable/disable/test as separate POST
  // actions, GET .../versions as a list) that used to be in this spec
  // never had ANY backing controller method -- the real controller only
  // exposes register/createVersion/setStatus/get/list. Replaced with the
  // routes that actually exist: PATCH .../status (enable/disable via a
  // status value) and POST .../versions (create a version, not list).
  // Trigger Registry has no version-listing endpoint at all today; that
  // capability is dropped from the contract rather than left as a
  // documented route that would 404 in reality.
  {
    method: "post",
    path: "/triggers",
    summary: "Create trigger",
    tag: "Triggers",
    successStatus: 201,
    responseSchema: RegisterTriggerResultSchema,
  },
  {
    method: "get",
    path: "/triggers",
    summary: "List triggers",
    tag: "Triggers",
    responseSchema: TriggerListResultSchema,
    queryParams: TriggerListQuerySchema,
  },
  {
    method: "get",
    path: "/triggers/{id}",
    summary: "Get trigger",
    tag: "Triggers",
    responseSchema: TriggerSchema,
  },
  {
    method: "post",
    path: "/triggers/{id}/versions",
    summary: "Create trigger version",
    tag: "Triggers",
    responseSchema: TriggerVersionSchema,
  },
  {
    method: "patch",
    path: "/triggers/{id}/status",
    summary: "Set trigger status",
    tag: "Triggers",
    responseSchema: TriggerSchema,
  },
  // ENG-BINDING. Trigger-to-integration binding + the per-integration webhook
  // endpoint a binding provisions. Rotation semantics (hard cutover, zero
  // overlap) are declared in trigger-bindings.ts and carried on the wire in
  // every WebhookEndpoint/RotateWebhookSecretResult body, so a platform test
  // can assert them rather than assume them.
  //
  // The public inbound receiver (POST /webhooks/integrations/{token}) is
  // deliberately NOT in this document: every route here is registered with
  // M2MAuth + ActorToken security, and the receiver is authenticated by HMAC
  // signature over the raw body instead of by a platform token. Its wire
  // contract lives in trigger-bindings.ts's header/algorithm constants.
  {
    method: "post",
    path: "/triggers/{id}/bindings",
    summary: "Bind trigger to integration connection",
    tag: "Triggers",
    successStatus: 201,
    requestBodySchema: CreateTriggerBindingRequestSchema,
    responseSchema: TriggerBindingSchema,
  },
  {
    method: "get",
    path: "/triggers/{id}/bindings",
    summary: "List trigger integration bindings",
    tag: "Triggers",
    responseSchema: TriggerBindingListSchema,
  },
  {
    method: "delete",
    path: "/triggers/{id}/bindings/{bid}",
    summary: "Disable trigger integration binding",
    tag: "Triggers",
    responseSchema: TriggerBindingSchema,
  },
  {
    method: "get",
    path: "/integrations/{id}/webhook-endpoint",
    summary: "Get integration webhook endpoint",
    tag: "Triggers",
    responseSchema: WebhookEndpointSchema,
  },
  {
    method: "post",
    path: "/webhook-endpoints/{id}/actions/rotate-secret",
    summary: "Rotate webhook signing secret",
    tag: "Triggers",
    responseSchema: RotateWebhookSecretResultSchema,
  },

  { method: "get", path: "/events", summary: "List canonical events", tag: "Events", collection: true },
  { method: "get", path: "/events/{id}", summary: "Get canonical event", tag: "Events" },
  { method: "get", path: "/conversations", summary: "List conversations", tag: "Conversations", collection: true },
  { method: "get", path: "/conversations/{id}", summary: "Get conversation", tag: "Conversations" },
  { method: "post", path: "/conversations/{id}/actions/close", summary: "Close conversation", tag: "Conversations" },
  { method: "post", path: "/conversations/{id}/actions/reopen", summary: "Reopen conversation", tag: "Conversations" },
  // Security fix: was an opaque Resource -- for a security-sensitive
  // export/handoff, an untyped response risks leaking raw content or a
  // permanent public URL through the contract itself. No real backend
  // exists for this route yet (grep of apps/ finds no conversation-level
  // handoff handler) -- this types the intended response shape only.
  {
    method: "post",
    path: "/conversations/{id}/actions/handoff",
    summary: "Hand off conversation",
    tag: "Conversations",
    responseSchema: SignedReferenceSchema,
  },

  { method: "get", path: "/approvals", summary: "List approvals", tag: "Human actions", collection: true, statusFilter: true },
  { method: "get", path: "/approvals/{id}", summary: "Get approval", tag: "Human actions" },
  { method: "post", path: "/approvals/{id}/actions/approve", summary: "Approve action", tag: "Human actions" },
  { method: "post", path: "/approvals/{id}/actions/reject", summary: "Reject action", tag: "Human actions" },
  { method: "get", path: "/escalations", summary: "List escalations", tag: "Human actions", collection: true },
  { method: "get", path: "/escalations/{id}", summary: "Get escalation", tag: "Human actions" },
  { method: "post", path: "/escalations/{id}/actions/claim", summary: "Claim escalation", tag: "Human actions" },
  { method: "post", path: "/escalations/{id}/actions/resolve", summary: "Resolve escalation", tag: "Human actions" },

  { method: "get", path: "/environments", summary: "List environments", tag: "Resources", collection: true },
  { method: "post", path: "/environments", summary: "Create environment", tag: "Resources", successStatus: 201 },
  { method: "patch", path: "/environments/{id}", summary: "Update environment", tag: "Resources" },
  { method: "get", path: "/integrations", summary: "List integrations", tag: "Resources", collection: true },
  { method: "post", path: "/integrations", summary: "Create integration", tag: "Resources", successStatus: 201 },
  { method: "post", path: "/integrations/{id}/actions/test", summary: "Test integration", tag: "Resources" },
  { method: "get", path: "/artifacts/{id}", summary: "Get artifact metadata", tag: "Resources" },
  { method: "get", path: "/artifacts/{id}/download", summary: "Get artifact download URL", tag: "Resources" },
  { method: "get", path: "/deployments/{id}", summary: "Get deployment", tag: "Resources" },

  {
    method: "post",
    path: "/ads/ingestion/uploads",
    summary: "Start ingestion upload",
    tag: "ADS",
    successStatus: 202,
    requestBodySchema: AdsUploadStartRequestSchema,
    responseSchema: AdsUploadStartResponseSchema,
  },
  {
    method: "post",
    path: "/ads/ingestion/uploads/complete",
    summary: "Complete ADS ingestion upload",
    tag: "ADS",
    successStatus: 202,
    requestBodySchema: AdsUploadCompleteRequestSchema,
    responseSchema: AdsIngestionJobSchema,
  },
  {
    method: "get",
    path: "/ads/ingestion/jobs/{id}",
    summary: "Get ingestion job",
    tag: "ADS",
    responseSchema: AdsIngestionJobSchema,
  },
  { method: "post", path: "/ads/sources", summary: "Create ADS source", tag: "ADS", successStatus: 201 },
  { method: "post", path: "/ads/sources/{id}/actions/sync", summary: "Sync ADS source", tag: "ADS", successStatus: 202 },
  {
    method: "get",
    path: "/ads/sources/{id}/permissions",
    summary: "Get ADS source permissions",
    tag: "ADS",
    responseSchema: AdsSourcePermissionsSchema.nullable(),
  },
  {
    method: "put",
    path: "/ads/sources/{id}/permissions",
    summary: "Replace ADS source permissions",
    tag: "ADS",
    requestBodySchema: AdsSourcePermissionsSchema,
    responseSchema: AdsSourcePermissionsSchema,
  },
  {
    method: "post",
    path: "/ads/query",
    summary: "Query ADS retrieval",
    tag: "ADS",
    idempotent: false,
    requestBodySchema: AdsRetrievalRequestSchema,
    responseSchema: AdsRetrievalResponseSchema,
  },
  { method: "get", path: "/ads/documents", summary: "List ADS documents", tag: "ADS", collection: true },
  { method: "get", path: "/ads/documents/{id}", summary: "Get ADS document", tag: "ADS" },
  { method: "post", path: "/ads/documents/{id}/actions/reindex", summary: "Reindex ADS document", tag: "ADS" },
  { method: "post", path: "/ads/knowledge", summary: "Create ADS knowledge", tag: "ADS", successStatus: 201 },
  { method: "delete", path: "/ads/documents/{id}", summary: "Delete ADS document", tag: "ADS" },

  { method: "get", path: "/costs/summary", summary: "Get cost summary", tag: "Cost and usage" },
  { method: "get", path: "/costs/by-run/{run_id}", summary: "Get costs by run", tag: "Cost and usage" },
  { method: "get", path: "/costs/by-workflow/{id}", summary: "Get costs by workflow", tag: "Cost and usage" },
  { method: "get", path: "/costs/by-project/{id}", summary: "Get costs by project", tag: "Cost and usage" },
  { method: "get", path: "/usage", summary: "Get usage series", tag: "Cost and usage", collection: true },
  { method: "get", path: "/budgets", summary: "Get budgets", tag: "Cost and usage", collection: true },
  { method: "patch", path: "/budgets", summary: "Update budgets", tag: "Cost and usage" },

  { method: "get", path: "/evaluations", summary: "List evaluations", tag: "Evaluations", collection: true },
  { method: "get", path: "/evaluation-runs", summary: "List evaluation runs", tag: "Evaluations", collection: true },
  { method: "get", path: "/benchmarks", summary: "List benchmarks", tag: "Evaluations", collection: true },
  { method: "get", path: "/release-gates", summary: "List release gates", tag: "Evaluations", collection: true },

  { method: "get", path: "/system/provider-health", summary: "Get provider capability health", tag: "Operations" },
  { method: "get", path: "/system/service-health", summary: "Get service health", tag: "Operations" },
  { method: "get", path: "/system/degraded-capabilities", summary: "Get degraded capabilities", tag: "Operations", collection: true },
  { method: "get", path: "/notifications", summary: "List notifications", tag: "Operations", collection: true },
  { method: "get", path: "/audit-events", summary: "List audit events", tag: "Operations", collection: true },
];

const GenericAlterIdSchema = z
  .string()
  .regex(/^[a-z]+_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

function pathParameters(path: string): z.ZodObject<Record<string, z.ZodType>> | undefined {
  const names = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
  if (names.length === 0) {
    return undefined;
  }

  const shape: Record<string, z.ZodType> = {};
  for (const name of names) {
    if (name === undefined) {
      continue;
    }
    if (name === "run_id") {
      shape[name] = RunIdSchema;
    } else if (name === "project_id") {
      shape[name] = ProjectIdSchema;
    } else if (name === "cid") {
      shape[name] = ClarificationIdSchema;
    } else {
      shape[name] = GenericAlterIdSchema;
    }
  }
  return z.object(shape);
}

const CursorQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const ApprovalQuerySchema = CursorQuerySchema.extend({
  status: z.literal("pending").optional(),
});

// Matches apps/orchestration-service/db/schema/runs.ts's real CHECK
// constraints exactly -- runs_status_check and the started_at column.
// No "mode" filter: runs.parent_kind is CHECK-restricted to the single
// value 'workflow' today (runs_parent_kind_check), so a mode filter would
// have exactly one possible value. Add it once Execution/Planning phases
// widen that constraint (e.g. adding 'project'), not before.
const RunsQuerySchema = CursorQuerySchema.extend({
  status: z
    .enum(["pending", "running", "paused", "completed", "failed", "cancelled"])
    .optional(),
  started_after: z.string().datetime({ offset: true }).optional(),
  started_before: z.string().datetime({ offset: true }).optional(),
});

const TraceHeadersSchema = z.object({
  traceparent: z.string().min(1),
});

const MutationHeadersSchema = TraceHeadersSchema.extend({
  "Idempotency-Key": z.string().min(1),
});

const PatchHeadersSchema = MutationHeadersSchema.extend({
  "If-Match": z.string().min(1),
});

const StreamHeadersSchema = TraceHeadersSchema.extend({
  "Last-Event-ID": z.string().min(1).optional(),
});

const ResponseTraceHeadersSchema = z.object({
  request_id: RequestIdSchema,
  trace_id: TraceIdSchema,
});

const AsyncResponseHeadersSchema = ResponseTraceHeadersSchema.extend({
  Location: z.string().startsWith("/api/v1/"),
});

const MutationBodySchema = z.record(z.string(), z.unknown());
const ResourceSchema = z.record(z.string(), z.unknown());

export function createOpenApiDocument(): AlterOpenApiDocument {
  const registry = new OpenAPIRegistry();

  const problemDetails = registry.register(
    "ProblemDetails",
    ProblemDetailsSchema,
  );
  const sseEnvelope = registry.register("SseEnvelope", SseEnvelopeSchema);
  registry.register("CanonicalEvent", CanonicalEventSchema);
  registry.register("ActorTokenClaims", ActorTokenClaimsSchema);
  registry.register("WorkflowDagDraft", WorkflowDagDraftSchema);
  registry.register("WorkflowDagCompiled", WorkflowDagCompiledSchema);
  registry.register("NodeRequirements", NodeRequirementsSchema);
  registry.register("PolicyBindings", PolicyBindingsSchema);
  registry.register("ProviderCapabilities", ProviderCapabilitiesSchema);
  registry.register("NodeType", NodeTypeSchema);

  const responseSchemaByRaw = new Map<z.ZodTypeAny, z.ZodTypeAny>([
    [NodeOverrideOptionsSchema, registry.register("NodeOverrideOptions", NodeOverrideOptionsSchema)],
    [NodeOverrideComparisonSchema, registry.register("NodeOverrideComparison", NodeOverrideComparisonSchema)],
    [TriggerSchema, registry.register("Trigger", TriggerSchema)],
    [TriggerVersionSchema, registry.register("TriggerVersion", TriggerVersionSchema)],
    [
      RegisterTriggerResultSchema,
      registry.register("RegisterTriggerResult", RegisterTriggerResultSchema),
    ],
    [
      TriggerListResultSchema,
      registry.register("TriggerListResult", TriggerListResultSchema),
    ],
    [TriggerBindingSchema, registry.register("TriggerBinding", TriggerBindingSchema)],
    [
      TriggerBindingListSchema,
      registry.register("TriggerBindingList", TriggerBindingListSchema),
    ],
    [WebhookEndpointSchema, registry.register("WebhookEndpoint", WebhookEndpointSchema)],
    [
      RotateWebhookSecretResultSchema,
      registry.register(
        "RotateWebhookSecretResult",
        RotateWebhookSecretResultSchema,
      ),
    ],
    [
      PromoteVersionResultSchema,
      registry.register("PromoteVersionResult", PromoteVersionResultSchema),
    ],
    [
      StartCanaryResultSchema,
      registry.register("StartCanaryResult", StartCanaryResultSchema),
    ],
    [
      RollbackVersionResultSchema,
      registry.register("RollbackVersionResult", RollbackVersionResultSchema),
    ],
    [
      TestVersionResultSchema,
      registry.register("TestVersionResult", TestVersionResultSchema),
    ],
    [SignedReferenceSchema, registry.register("SignedReference", SignedReferenceSchema)],
    [
      AdsRetrievalResponseSchema,
      registry.register("AdsRetrievalResponse", AdsRetrievalResponseSchema),
    ],
    [
      AdsUploadStartResponseSchema,
      registry.register("AdsUploadStartResponse", AdsUploadStartResponseSchema),
    ],
    [
      AdsIngestionJobSchema,
      registry.register("AdsIngestionJob", AdsIngestionJobSchema),
    ],
    [
      AdsSourcePermissionsSchema.nullable(),
      registry.register(
        "AdsSourcePermissionsNullable",
        AdsSourcePermissionsSchema.nullable(),
      ),
    ],
    [
      AdsSourcePermissionsSchema,
      registry.register("AdsSourcePermissions", AdsSourcePermissionsSchema),
    ],
  ]);
  const requestBodySchemaByRaw = new Map<z.ZodTypeAny, z.ZodTypeAny>([
    [NodeOverrideRequestSchema, registry.register("NodeOverrideRequest", NodeOverrideRequestSchema)],
    [
      TestVersionRequestSchema,
      registry.register("TestVersionRequest", TestVersionRequestSchema),
    ],
    [
      AdsRetrievalRequestSchema,
      registry.register("AdsRetrievalRequest", AdsRetrievalRequestSchema),
    ],
    [
      AdsUploadStartRequestSchema,
      registry.register("AdsUploadStartRequest", AdsUploadStartRequestSchema),
    ],
    [
      AdsUploadCompleteRequestSchema,
      registry.register("AdsUploadCompleteRequest", AdsUploadCompleteRequestSchema),
    ],
    [
      CreateTriggerBindingRequestSchema,
      registry.register(
        "CreateTriggerBindingRequest",
        CreateTriggerBindingRequestSchema,
      ),
    ],
    [
      AdsSourcePermissionsSchema,
      registry.register("AdsSourcePermissions", AdsSourcePermissionsSchema),
    ],
  ]);

  const page = registry.register(
    "CursorPage",
    z
      .object({
        next_cursor: z.string().nullable(),
        has_more: z.boolean(),
        limit: z.number().int().min(1).max(200),
      })
      .strict(),
  );
  const paginatedResponse = registry.register(
    "PaginatedResponse",
    z
      .object({
        data: z.array(ResourceSchema),
        page,
      })
      .strict(),
  );
  const resource = registry.register("Resource", ResourceSchema);

  registry.registerComponent("securitySchemes", "M2MAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description: "Authorization: Bearer <M2M access token>",
  });
  registry.registerComponent("securitySchemes", "ActorToken", {
    type: "apiKey",
    in: "header",
    name: "X-Alter-Actor-Token",
    description: "Alter signed delegation JWT with a maximum five-minute lifetime",
  });

  for (const route of V1_ROUTE_SPECS) {
    const mutation = route.method !== "get";
    const successStatus =
      route.successStatus ?? (route.method === "post" ? 200 : 200);
    const request: NonNullable<RouteConfig["request"]> = {
      headers: route.sse
        ? StreamHeadersSchema
        : route.method === "patch"
          ? PatchHeadersSchema
          : mutation && route.idempotent !== false
            ? MutationHeadersSchema
            : TraceHeadersSchema,
    };
    const params = pathParameters(route.path);
    if (params !== undefined) {
      request.params = params;
    }
    if (route.queryParams) {
      request.query = route.queryParams;
    } else if (route.collection) {
      request.query = route.statusFilter
        ? ApprovalQuerySchema
        : route.runsFilter
          ? RunsQuerySchema
          : CursorQuerySchema;
    }
    if (mutation) {
      request.body = {
        required: false,
        description: "Typed resource or action input",
        content: {
          "application/json": {
            schema: route.requestBodySchema
              ? (requestBodySchemaByRaw.get(route.requestBodySchema) ??
                route.requestBodySchema)
              : MutationBodySchema,
          },
        },
      };
    }

    registry.registerPath({
      method: route.method,
      path: `/api/v1${route.path}`,
      operationId: `${route.method}_${route.path}`
        .replaceAll(/[{}]/g, "")
        .replaceAll(/[^a-zA-Z0-9]+/g, "_")
        .replace(/^_|_$/g, ""),
      summary: route.summary,
      tags: [route.tag],
      security: [{ M2MAuth: [], ActorToken: [] }],
      request,
      responses: {
        [successStatus]: {
          description: "Successful response",
          headers:
            successStatus === 202
              ? AsyncResponseHeadersSchema
              : ResponseTraceHeadersSchema,
          content: route.sse
            ? {
                "text/event-stream": {
                  schema: sseEnvelope,
                },
              }
            : {
                "application/json": {
                  schema: route.responseSchema
                    ? (responseSchemaByRaw.get(route.responseSchema) ??
                      route.responseSchema)
                    : route.collection
                      ? paginatedResponse
                      : resource,
                },
              },
        },
        default: {
          description: "RFC 9457 problem response",
          headers: ResponseTraceHeadersSchema,
          content: {
            "application/problem+json": {
              schema: problemDetails,
            },
          },
        },
      },
    });
  }

  const document = new OpenApiGeneratorV31(registry.definitions, {
    unionPreferredType: "oneOf",
    sortComponents: "alphabetically",
  }).generateDocument({
    openapi: "3.1.1",
    info: {
      title: "Alter Private Platform API",
      version: "1.0.0",
      description:
        "Private Platform-only API. No customer API keys or public SDK surface in v1.",
    },
    servers: [{ url: "/" }],
  });

  return {
    ...document,
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
  };
}
