import { randomBytes } from "node:crypto";

import { Controller, HttpException, Post, Req } from "@nestjs/common";
import type { IdentityTenantGatewayRequest } from "@alterx/auth";
import type { ProblemDetails, RetentionSweepResult, VerificationResult } from "@alterx/contracts";

import { OrchestrationDeletionService } from "./deletion.service";

function requiredTenantId(request: IdentityTenantGatewayRequest): string {
  const tenantId = request.actorContext?.tenant_id;
  if (tenantId === undefined) {
    throw new HttpException(
      problem(request.url, 500, "DELETION_INTERNAL_ERROR", "Missing authenticated tenant context"),
      500,
    );
  }
  return tenantId;
}

@Controller("api/v1/deletion-requests")
export class DeletionRequestController {
  constructor(private readonly service: OrchestrationDeletionService) {}

  @Post()
  async deleteAndVerify(@Req() request: IdentityTenantGatewayRequest): Promise<VerificationResult> {
    const tenantId = requiredTenantId(request);
    const manifestId = `del_${uuidV7()}`;
    try {
      await this.service.deleteSubjectData(tenantId, manifestId);
      return await this.service.verifyDeletion(tenantId, manifestId);
    } catch (error: unknown) {
      throw mapDeletionError(error, request.url);
    }
  }

  @Post("retention")
  async retention(@Req() request: IdentityTenantGatewayRequest): Promise<RetentionSweepResult> {
    const tenantId = requiredTenantId(request);
    try {
      return await this.service.applyTenantRetentionPolicy(tenantId);
    } catch (error: unknown) {
      throw mapDeletionError(error, request.url);
    }
  }
}

function mapDeletionError(error: unknown, requestUrl: string | undefined): HttpException {
  if (error instanceof HttpException) return error;
  return new HttpException(
    problem(requestUrl, 500, "DELETION_INTERNAL_ERROR", "Deletion request could not be completed"),
    500,
  );
}

function problem(
  requestUrl: string | undefined,
  status: 500,
  errorCode: "DELETION_INTERNAL_ERROR",
  detail: string,
): ProblemDetails {
  return {
    type: "https://alter.dev/problems/deletion-internal-error",
    title: "Internal Server Error",
    status,
    detail,
    instance: requestUrl?.startsWith("/") ? requestUrl : "/",
    error_code: errorCode,
    trace_id: prefixedUuidV7("trc"),
    request_id: prefixedUuidV7("req"),
    retryable: false,
    field_errors: [],
    documentation_key: "deletion.internal-error",
  };
}

function prefixedUuidV7(prefix: "trc" | "req"): `${typeof prefix}_${string}` {
  return `${prefix}_${uuidV7()}`;
}

function uuidV7(): string {
  const bytes = randomBytes(16);
  let timestamp = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes.readUInt8(6) & 0x0f) | 0x70;
  bytes[8] = (bytes.readUInt8(8) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
