import { randomBytes } from "node:crypto";
import type { JsonValue } from "@alterx/shared-clients";
import type {
  RetentionSweepResult,
  VerificationResult,
} from "@alterx/contracts";
import {
  EngineClient,
  EngineProblemError,
  type EngineCallerContext,
  type EngineRequestBody,
  type EngineResponse,
} from "../engine";
import type { ActorContext } from "../rbac/types";
import { AdsHttpError } from "./problem";
import type {
  AdsCoreIngestionJob,
  AdsCorePresignUploadResponse,
  AdsInput,
  AdsCoreRetrievalResponse,
  AdsIngestionJob,
  AdsPage,
  AdsPagination,
  AdsResource,
  AdsRetrievalQuery,
  AdsRetrievalResponse,
  AdsSourcePermissions,
  AdsUploadCompleteRequest,
  AdsUploadStartRequest,
  AdsUploadStartResponse,
  DocumentPermissions,
  DocumentPermissionsPatch,
} from "./types";
import { parseAdsId, parseTraceparent } from "./validation";

export class AdsService {
  constructor(private readonly engine: EngineClient) {}

  requestDeletion(
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<VerificationResult>> {
    const instance = "/api/v1/ads/deletion-requests";
    return this.engine.post(
      "/api/v1/deletion-requests",
      {},
      callerContext(actor, traceparent, instance),
      { idempotencyKey },
    );
  }

  applyRetention(
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<RetentionSweepResult>> {
    const instance = "/api/v1/ads/deletion-requests/retention";
    return this.engine.post(
      "/api/v1/deletion-requests/retention",
      {},
      callerContext(actor, traceparent, instance),
      { idempotencyKey },
    );
  }

  createSource(
    input: AdsInput,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<AdsResource>> {
    return this.post(
      "/api/v1/ads/sources",
      input,
      actor,
      traceparent,
      idempotencyKey,
    );
  }

  sources(
    pagination: AdsPagination,
    actor: ActorContext,
    traceparent: string | undefined,
  ): Promise<EngineResponse<AdsPage>> {
    const instance = "/api/v1/ads/sources";
    return this.engine.get(
      withPagination(instance, pagination),
      callerContext(actor, traceparent, instance),
    );
  }

  sourceDetail(
    sourceId: string,
    actor: ActorContext,
    traceparent: string | undefined,
  ): Promise<EngineResponse<AdsResource>> {
    const instance = `/api/v1/ads/sources/${sourceId}/detail`;
    const id = parseAdsId(sourceId, "sourceId", instance);
    return this.engine.get(
      `/api/v1/ads/sources/${encodeURIComponent(id)}/detail`,
      callerContext(actor, traceparent, instance),
    );
  }

  syncSource(
    sourceId: string,
    input: AdsInput,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<AdsResource>> {
    const instance = `/api/v1/ads/sources/${sourceId}/actions/sync`;
    const id = parseAdsId(sourceId, "sourceId", instance);
    return this.post(
      `/api/v1/ads/sources/${encodeURIComponent(id)}/actions/sync`,
      input,
      actor,
      traceparent,
      idempotencyKey,
    );
  }

  sourcePermissions(
    sourceId: string,
    actor: ActorContext,
    traceparent: string | undefined,
  ): Promise<EngineResponse<AdsSourcePermissions | null>> {
    const instance = `/api/v1/ads/sources/${sourceId}/permissions`;
    const id = parseAdsId(sourceId, "sourceId", instance);
    return this.engine.get(
      `/api/v1/ads/sources/${encodeURIComponent(id)}/permissions`,
      callerContext(actor, traceparent, instance),
    );
  }

  replaceSourcePermissions(
    sourceId: string,
    input: AdsSourcePermissions,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
    ifMatch: string,
  ): Promise<EngineResponse<AdsSourcePermissions>> {
    const instance = `/api/v1/ads/sources/${sourceId}/permissions`;
    const id = parseAdsId(sourceId, "sourceId", instance);
    return this.engine.put(
      `/api/v1/ads/sources/${encodeURIComponent(id)}/permissions`,
      input as EngineRequestBody,
      callerContext(actor, traceparent, instance),
      { idempotencyKey, ifMatch },
    );
  }

  createUpload(
    input: AdsUploadStartRequest,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<AdsUploadStartResponse>> {
    return this.engine.post<
      EngineRequestBody,
      AdsCorePresignUploadResponse
    >(
      "/api/v1/ads/ingestion/uploads/presign",
      input as EngineRequestBody,
      callerContext(actor, traceparent, "/api/v1/ads/ingestion/uploads"),
      { idempotencyKey },
    ).then((response) => ({
      ...response,
      status: 202,
      location: `/api/v1/ads/ingestion/jobs/${response.body.ingestion_job_id}`,
      body: {
        ingestion_job_id: response.body.ingestion_job_id,
        upload: {
          signed_url: response.body.upload_url,
          expires_at: response.body.expires_at,
        },
        upload_fields: response.body.upload_fields,
        upload_key: response.body.upload_key,
        max_content_bytes: response.body.max_content_bytes,
      },
    }));
  }

  completeUpload(
    input: AdsUploadCompleteRequest,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<AdsIngestionJob>> {
    const instance = "/api/v1/ads/ingestion/uploads/complete";
    return this.engine.post<EngineRequestBody, AdsCoreIngestionJob>(
      instance,
      input as EngineRequestBody,
      callerContext(actor, traceparent, instance),
      { idempotencyKey },
    ).then((response) => ({
      ...response,
      body: toIngestionJob(response.body),
    }));
  }

  ingestionJob(
    jobId: string,
    actor: ActorContext,
    traceparent: string | undefined,
  ): Promise<EngineResponse<AdsIngestionJob>> {
    const instance = `/api/v1/ads/ingestion/jobs/${jobId}`;
    const id = parseAdsId(jobId, "jobId", instance);
    return this.engine.get<AdsCoreIngestionJob>(
      `/api/v1/ads/ingestion/jobs/${encodeURIComponent(id)}`,
      callerContext(actor, traceparent, instance),
    ).then((response) => ({
      ...response,
      body: toIngestionJob(response.body),
    }));
  }

  documents(
    pagination: AdsPagination,
    actor: ActorContext,
    traceparent: string | undefined,
    sourceId?: string,
  ): Promise<EngineResponse<AdsPage>> {
    const instance = "/api/v1/ads/documents";
    const path = withPagination(instance, pagination);
    const source =
      sourceId === undefined ? undefined : parseAdsId(sourceId, "sourceId", instance);
    return this.engine.get(
      source === undefined
        ? path
        : (`${path}${path.includes("?") ? "&" : "?"}source_id=${encodeURIComponent(source)}` as `/api/v1/${string}`),
      callerContext(actor, traceparent, instance),
    );
  }

  document(
    documentId: string,
    actor: ActorContext,
    traceparent: string | undefined,
  ): Promise<EngineResponse<AdsResource>> {
    const instance = `/api/v1/ads/documents/${documentId}`;
    const id = parseAdsId(documentId, "documentId", instance);
    return this.engine.get(
      `/api/v1/ads/documents/${encodeURIComponent(id)}`,
      callerContext(actor, traceparent, instance),
    );
  }

  documentPermissions(
    documentId: string,
    actor: ActorContext,
    traceparent: string | undefined,
  ): Promise<EngineResponse<DocumentPermissions | null>> {
    const instance = `/api/v1/ads/documents/${documentId}/permissions`;
    const id = parseAdsId(documentId, "documentId", instance);
    return this.engine.get(
      `/api/v1/ads/documents/${encodeURIComponent(id)}/permissions`,
      callerContext(actor, traceparent, instance),
    );
  }

  updateDocumentPermissions(
    documentId: string,
    input: DocumentPermissionsPatch,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
    ifMatch: string,
  ): Promise<EngineResponse<DocumentPermissions>> {
    const instance = `/api/v1/ads/documents/${documentId}/permissions`;
    const id = parseAdsId(documentId, "documentId", instance);
    return this.engine.patch(
      `/api/v1/ads/documents/${encodeURIComponent(id)}/permissions`,
      input as EngineRequestBody,
      callerContext(actor, traceparent, instance),
      { idempotencyKey, ifMatch },
    );
  }

  reindexDocument(
    documentId: string,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<AdsResource>> {
    const instance = `/api/v1/ads/documents/${documentId}/actions/reindex`;
    const id = parseAdsId(documentId, "documentId", instance);
    return this.post(
      `/api/v1/ads/documents/${encodeURIComponent(id)}/actions/reindex`,
      {},
      actor,
      traceparent,
      idempotencyKey,
    );
  }

  deleteDocument(
    documentId: string,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<AdsResource>> {
    const instance = `/api/v1/ads/documents/${documentId}`;
    const id = parseAdsId(documentId, "documentId", instance);
    return this.engine.delete(
      `/api/v1/ads/documents/${encodeURIComponent(id)}`,
      callerContext(actor, traceparent, instance),
      { idempotencyKey },
    );
  }

  createKnowledge(
    input: AdsInput,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<AdsResource>> {
    return this.post(
      "/api/v1/ads/knowledge",
      input,
      actor,
      traceparent,
      idempotencyKey,
    );
  }

  async query(
    input: AdsRetrievalQuery,
    actor: ActorContext,
    traceparent: string | undefined,
  ): Promise<EngineResponse<AdsRetrievalResponse>> {
    const instance = "/api/v1/ads/query";
    try {
      return await this.engine.queryAds<
        AdsRetrievalQuery,
        AdsCoreRetrievalResponse
      >(
        input,
        callerContext(actor, traceparent, instance),
      ).then((response) => ({
        ...response,
        body: toRetrievalResponse(input, response.body),
      }));
    } catch (error) {
      if (!(error instanceof EngineProblemError)) throw error;
      if (error.problem.status === 403) {
        throw new AdsHttpError(
          403,
          "ADS_SCOPE_VIOLATION",
          "Requested ADS scope is unavailable",
          instance,
        );
      }
      if (error.problem.status === 429) {
        throw new AdsHttpError(
          429,
          "ADS_RETRIEVAL_BACKPRESSURE",
          "ADS retrieval is at capacity; retry shortly",
          instance,
          [],
          true,
        );
      }
      if (error.problem.status === 422) {
        throw new AdsHttpError(
          422,
          "ADS_RETRIEVAL_INVALID",
          "ADS retrieval request rejected",
          instance,
        );
      }
      throw error;
    }
  }

  private post(
    path: `/api/v1/${string}`,
    input: AdsInput,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<AdsResource>> {
    return this.engine.post(
      path,
      input as EngineRequestBody,
      callerContext(actor, traceparent, path),
      { idempotencyKey },
    );
  }
}

function toRetrievalResponse(
  input: AdsRetrievalQuery,
  upstream: AdsCoreRetrievalResponse,
): AdsRetrievalResponse {
  const rerank = input.rerank ?? true;
  return {
    results: upstream.hits.map((hit) => ({
      id: hit.chunk_id,
      document_id: hit.document_id,
      chunk_id: hit.chunk_id,
      chunk_reference: hit.chunk_id,
      source_id: hit.source_id,
      scope_id: hit.scope_id,
      text: hit.context,
      reconstructed_text: hit.reconstructed_context,
      score: hit.score,
      confidence: hit.confidence,
      provenance: hit.provenance,
      metadata: hit.metadata,
      freshness_at: hit.freshness_at,
      semantic_score: hit.semantic_score,
      keyword_score: hit.keyword_score,
    })),
    query: {
      query: input.query,
      top_k: input.top_k ?? 10,
      rerank,
      scope_ids: input.scope_ids ?? [],
      source_ids: input.source_ids ?? [],
      project_id: input.project_id,
      workflow_id: input.workflow_id,
      metadata_filter: input.metadata_filter ?? {},
      audited_at: upstream.audited_at,
    },
  };
}

const ingestionStages = [
  "received",
  "validated",
  "scanned",
  "normalized",
  "deduplicated",
  "chunked",
  "indexed",
  "failed",
] as const;

function toIngestionJob(upstream: AdsCoreIngestionJob): AdsIngestionJob {
  const stageIndex = ingestionStages.indexOf(upstream.stage);
  const totalStages = ingestionStages.length - 1;
  const completedStages =
    upstream.stage === "failed"
      ? Math.max(0, stageIndex)
      : Math.max(0, stageIndex + 1);
  return {
    ingestion_job_id: upstream.ingestion_job_id,
    source_id: upstream.source_id,
    status: ingestionStatus(upstream),
    stage: upstream.stage,
    progress: {
      completed_stages: Math.min(completedStages, totalStages),
      total_stages: totalStages,
      percent: Math.round((Math.min(completedStages, totalStages) / totalStages) * 100),
      current_stage: upstream.stage,
    },
    document_ids: documentIds(upstream.stats),
    failure_detail: upstream.error,
    created_at: upstream.created_at,
    completed_at: upstream.completed_at,
  };
}

function ingestionStatus(
  job: AdsCoreIngestionJob,
): "queued" | "in_progress" | "completed" | "failed" {
  if (job.stage === "failed") return "failed";
  if (job.stage === "indexed") return "completed";
  if (job.stage === "received") return "queued";
  return "in_progress";
}

function documentIds(stats: Record<string, JsonValue>): string[] {
  const deduplication = stats["deduplication"];
  if (
    typeof deduplication !== "object" ||
    deduplication === null ||
    Array.isArray(deduplication)
  ) {
    return [];
  }
  const deduplicationRecord = deduplication as Record<string, JsonValue>;
  const ids = [
    deduplicationRecord["document_id"],
    deduplicationRecord["duplicate_of_document_id"],
  ];
  return ids.filter((id): id is string => typeof id === "string");
}

function callerContext(
  actor: ActorContext,
  traceparent: string | undefined,
  instance: string,
): EngineCallerContext {
  if (!actor.workspace_id) {
    throw new AdsHttpError(
      403,
      "ADS_WORKSPACE_REQUIRED",
      "Workspace actor context required",
      instance,
    );
  }
  return {
    userId: actor.user_id,
    tenantId: actor.tenant_id,
    workspaceId: actor.workspace_id,
    sessionId: actor.session_id,
    authTime: actor.auth_time ?? Math.floor(Date.now() / 1_000),
    roles: actor.roles,
    permissions: actor.permissions,
    traceparent: parseTraceparent(traceparent, instance) ?? newTraceparent(),
  };
}

function withPagination(
  path: `/api/v1/${string}`,
  pagination: AdsPagination,
): `/api/v1/${string}` {
  const query = new URLSearchParams();
  if (pagination.cursor) query.set("cursor", pagination.cursor);
  if (pagination.limit !== undefined) {
    query.set("limit", pagination.limit.toString());
  }
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}

function newTraceparent(): string {
  return `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
}
