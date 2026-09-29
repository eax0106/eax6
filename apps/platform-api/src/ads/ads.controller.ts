import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseFilters,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type {
  RetentionSweepResult,
  VerificationResult,
} from "@alterx/contracts";
import type { EngineResponse } from "../engine";
import { Idempotent } from "../idempotency";
import {
  ActorContext,
  RequirePermission,
  RequireTenantRole,
  RequireWorkspaceRole,
} from "../rbac";
import type { ActorContextType } from "../rbac";
import { AdsExceptionFilter } from "./ads-exception.filter";
import { AdsService } from "./ads.service";
import { AdsHttpError } from "./problem";
import type {
  AdsIngestionJob,
  AdsPage,
  AdsResource,
  AdsRetrievalResponse,
  AdsSourcePermissions,
  AdsUploadStartResponse,
  DocumentPermissions,
} from "./types";
import {
  parseAdsInput,
  parseAdsPagination,
  parseAdsRetrievalQuery,
  parseAdsUploadComplete,
  parseAdsUploadStart,
  parseDocumentPermissionsPatch,
  parseSourcePermissions,
  requireIfMatch,
} from "./validation";

const readRoles = ["admin", "editor", "operator", "approver", "viewer"] as const;
const adminRoles = ["admin", "editor"] as const;
const deleteRoles = ["admin"] as const;

@Controller("/api/v1/ads")
@UseFilters(AdsExceptionFilter)
export class AdsController {
  constructor(private readonly ads: AdsService) {}

  @Post("deletion-requests")
  @RequireTenantRole("owner")
  @RequirePermission("knowledge:delete")
  @Idempotent()
  async requestDeletion(
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<VerificationResult> {
    const instance = "/api/v1/ads/deletion-requests";
    return project(
      await this.ads.requestDeletion(
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
      ),
      reply,
    );
  }

  @Post("deletion-requests/retention")
  @RequireTenantRole("admin")
  @RequirePermission("knowledge:admin")
  @Idempotent()
  async applyRetention(
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<RetentionSweepResult> {
    const instance = "/api/v1/ads/deletion-requests/retention";
    return project(
      await this.ads.applyRetention(
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
      ),
      reply,
    );
  }

  @Post("query")
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("knowledge:read")
  async query(
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AdsRetrievalResponse> {
    const instance = "/api/v1/ads/query";
    return project(
      await this.ads.query(
        parseAdsRetrievalQuery(body, instance),
        requireActor(actor, instance),
        traceparent,
      ),
      reply,
    );
  }

  @Post("sources")
  @RequireWorkspaceRole(...adminRoles)
  @RequirePermission("knowledge:admin")
  @Idempotent()
  async createSource(
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AdsResource> {
    const instance = "/api/v1/ads/sources";
    return project(
      await this.ads.createSource(
        parseAdsInput(body, instance),
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
      ),
      reply,
    );
  }

  @Get("sources")
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("knowledge:read")
  async sources(
    @Query("cursor") cursor: string | undefined,
    @Query("limit") limit: string | undefined,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AdsPage> {
    const instance = "/api/v1/ads/sources";
    return project(
      await this.ads.sources(
        parseAdsPagination(cursor, limit, instance),
        requireActor(actor, instance),
        traceparent,
      ),
      reply,
    );
  }

  @Get("sources/:sourceId/detail")
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("knowledge:read")
  async sourceDetail(
    @Param("sourceId") sourceId: string,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AdsResource> {
    const instance = `/api/v1/ads/sources/${sourceId}/detail`;
    return project(
      await this.ads.sourceDetail(
        sourceId,
        requireActor(actor, instance),
        traceparent,
      ),
      reply,
    );
  }

  @Post("ingestion/uploads/complete")
  @HttpCode(202)
  @RequireWorkspaceRole(...adminRoles)
  @RequirePermission("knowledge:admin")
  @Idempotent()
  async completeUpload(
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AdsIngestionJob> {
    const instance = "/api/v1/ads/ingestion/uploads/complete";
    return project(
      await this.ads.completeUpload(
        parseAdsUploadComplete(body, instance),
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
      ),
      reply,
    );
  }

  @Post("sources/:sourceId/actions/sync")
  @HttpCode(202)
  @RequireWorkspaceRole(...adminRoles)
  @RequirePermission("knowledge:admin")
  @Idempotent()
  async syncSource(
    @Param("sourceId") sourceId: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AdsResource> {
    const instance = `/api/v1/ads/sources/${sourceId}/actions/sync`;
    return project(
      await this.ads.syncSource(
        sourceId,
        parseAdsInput(body, instance),
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
      ),
      reply,
    );
  }

  @Get("sources/:sourceId/permissions")
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("knowledge:read")
  async sourcePermissions(
    @Param("sourceId") sourceId: string,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AdsSourcePermissions | null> {
    const instance = `/api/v1/ads/sources/${sourceId}/permissions`;
    return project(
      await this.ads.sourcePermissions(
        sourceId,
        requireActor(actor, instance),
        traceparent,
      ),
      reply,
    );
  }

  @Put("sources/:sourceId/permissions")
  @RequireWorkspaceRole(...adminRoles)
  @RequirePermission("knowledge:admin")
  @Idempotent()
  async replaceSourcePermissions(
    @Param("sourceId") sourceId: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Headers("if-match") ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AdsSourcePermissions> {
    const instance = `/api/v1/ads/sources/${sourceId}/permissions`;
    return project(
      await this.ads.replaceSourcePermissions(
        sourceId,
        parseSourcePermissions(body, instance),
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
        requireIfMatch(ifMatch, instance),
      ),
      reply,
    );
  }

  @Post("ingestion/uploads")
  @HttpCode(202)
  @RequireWorkspaceRole(...adminRoles)
  @RequirePermission("knowledge:admin")
  @Idempotent()
  async createUpload(
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AdsUploadStartResponse> {
    const instance = "/api/v1/ads/ingestion/uploads";
    return project(
      await this.ads.createUpload(
        parseAdsUploadStart(body, instance),
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
      ),
      reply,
    );
  }

  @Get("ingestion/jobs/:jobId")
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("knowledge:read")
  async ingestionJob(
    @Param("jobId") jobId: string,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AdsIngestionJob> {
    const instance = `/api/v1/ads/ingestion/jobs/${jobId}`;
    return project(
      await this.ads.ingestionJob(
        jobId,
        requireActor(actor, instance),
        traceparent,
      ),
      reply,
    );
  }

  @Get("documents")
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("knowledge:read")
  async documents(
    @Query("cursor") cursor: string | undefined,
    @Query("limit") limit: string | undefined,
    @Query("sourceId") sourceId: string | undefined,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AdsPage> {
    const instance = "/api/v1/ads/documents";
    return project(
      await this.ads.documents(
        parseAdsPagination(cursor, limit, instance),
        requireActor(actor, instance),
        traceparent,
        sourceId,
      ),
      reply,
    );
  }

  @Get("documents/:documentId")
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("knowledge:read")
  async document(
    @Param("documentId") documentId: string,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AdsResource> {
    const instance = `/api/v1/ads/documents/${documentId}`;
    return project(
      await this.ads.document(
        documentId,
        requireActor(actor, instance),
        traceparent,
      ),
      reply,
    );
  }

  @Get("documents/:documentId/permissions")
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("knowledge:read")
  async documentPermissions(
    @Param("documentId") documentId: string,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DocumentPermissions | null> {
    const instance = `/api/v1/ads/documents/${documentId}/permissions`;
    return project(
      await this.ads.documentPermissions(
        documentId,
        requireActor(actor, instance),
        traceparent,
      ),
      reply,
    );
  }

  @Patch("documents/:documentId/permissions")
  @RequireWorkspaceRole(...adminRoles)
  @RequirePermission("knowledge:admin")
  @Idempotent()
  async updateDocumentPermissions(
    @Param("documentId") documentId: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Headers("if-match") ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DocumentPermissions> {
    const instance = `/api/v1/ads/documents/${documentId}/permissions`;
    return project(
      await this.ads.updateDocumentPermissions(
        documentId,
        parseDocumentPermissionsPatch(body, instance),
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
        requireIfMatch(ifMatch, instance),
      ),
      reply,
    );
  }

  @Post("documents/:documentId/actions/reindex")
  @RequireWorkspaceRole(...adminRoles)
  @RequirePermission("knowledge:admin")
  @Idempotent()
  async reindexDocument(
    @Param("documentId") documentId: string,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AdsResource> {
    const instance = `/api/v1/ads/documents/${documentId}/actions/reindex`;
    return project(
      await this.ads.reindexDocument(
        documentId,
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
      ),
      reply,
    );
  }

  @Delete("sources/:sourceId")
  @RequireWorkspaceRole(...deleteRoles)
  @RequirePermission("knowledge:delete")
  @Idempotent()
  async deleteSource(
    @Param("sourceId") sourceId: string,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AdsResource> {
    const instance = `/api/v1/ads/sources/${sourceId}`;
    return project(
      await this.ads.deleteSource(
        sourceId,
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
      ),
      reply,
    );
  }

  @Delete("documents/:documentId")
  @RequireWorkspaceRole(...deleteRoles)
  @RequirePermission("knowledge:delete")
  @Idempotent()
  async deleteDocument(
    @Param("documentId") documentId: string,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AdsResource> {
    const instance = `/api/v1/ads/documents/${documentId}`;
    return project(
      await this.ads.deleteDocument(
        documentId,
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
      ),
      reply,
    );
  }

  @Post("knowledge")
  @RequireWorkspaceRole(...adminRoles)
  @RequirePermission("knowledge:admin")
  @Idempotent()
  async createKnowledge(
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AdsResource> {
    const instance = "/api/v1/ads/knowledge";
    return project(
      await this.ads.createKnowledge(
        parseAdsInput(body, instance),
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
      ),
      reply,
    );
  }
}

function requireActor(
  actor: ActorContextType | undefined,
  instance: string,
): ActorContextType {
  if (!actor) {
    throw new AdsHttpError(
      401,
      "AUTHENTICATION_REQUIRED",
      "Authenticated actor required",
      instance,
    );
  }
  return actor;
}

function project<T>(response: EngineResponse<T>, reply: FastifyReply): T {
  reply.status(response.status);
  if (response.location) reply.header("Location", response.location);
  if (response.requestId) reply.header("request_id", response.requestId);
  if (response.traceId) reply.header("trace_id", response.traceId);
  return response.body;
}
