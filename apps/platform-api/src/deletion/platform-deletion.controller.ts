import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Body, Controller, Get, Headers, HttpException, Inject, Post, Query } from "@nestjs/common";
import type { ProblemDetails } from "@alterx/contracts";
import { Public } from "../rbac/decorators";
import { PlatformDeletionService } from "./platform-deletion.service";

export const PLATFORM_DELETION_TOKEN_HASH = Symbol("PLATFORM_DELETION_TOKEN_HASH");

interface DeleteBody {
  readonly tenantId?: string;
  readonly manifestId?: string;
}

/**
 * The erasure provider audit-service's DeletionOrchestrator calls for platform_db
 * (D2, C3b). Internal only: the shared deletion service token is the boundary,
 * the same secret platform-api already holds to call audit-service. `@Public()`
 * skips the per-actor RBAC guard because there is no user here.
 */
@Controller("internal/deletion")
export class PlatformDeletionController {
  constructor(
    private readonly service: PlatformDeletionService,
    @Inject(PLATFORM_DELETION_TOKEN_HASH) private readonly tokenHash: string | (() => Promise<string>),
  ) {}

  @Public()
  @Get("locate")
  async locate(@Query("tenantId") tenantId?: string, @Headers("authorization") auth?: string) {
    await this.authorize(auth);
    return this.run("locate", () => this.service.locateSubjectData(required(tenantId, "tenantId")));
  }

  @Public()
  @Post("delete")
  async delete(@Body() body: DeleteBody, @Headers("authorization") auth?: string) {
    await this.authorize(auth);
    return this.run("delete", () =>
      this.service.deleteSubjectData(required(body?.tenantId, "tenantId"), required(body?.manifestId, "manifestId")),
    );
  }

  @Public()
  @Post("verify")
  async verify(@Body() body: DeleteBody, @Headers("authorization") auth?: string) {
    await this.authorize(auth);
    return this.run("verify", () =>
      this.service.verifyDeletion(required(body?.tenantId, "tenantId"), required(body?.manifestId, "manifestId")),
    );
  }

  @Public()
  @Post("retention")
  async retention(@Headers("authorization") auth?: string) {
    await this.authorize(auth);
    return this.run("retention", () => this.service.applyRetentionPolicy());
  }

  @Public()
  @Get("subjects")
  async subjects(@Headers("authorization") auth?: string) {
    await this.authorize(auth);
    return this.run("subjects", () => this.service.listSubjectIds());
  }

  private async run<T>(operation: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error: unknown) {
      if (error instanceof MissingField || (error instanceof Error && /must be (a )?(ten_|del_)/.test(error.message))) {
        throw new HttpException(problem(operation, 400, "DELETION_VALIDATION_FAILED", (error as Error).message), 400);
      }
      throw new HttpException(problem(operation, 500, "DELETION_INTERNAL_ERROR", "Deletion request could not be completed"), 500);
    }
  }

  private async authorize(value: string | undefined): Promise<void> {
    const token = value?.startsWith("Bearer ") ? value.slice(7) : "";
    const actual = createHash("sha256").update(token).digest();
    const expected = Buffer.from(typeof this.tokenHash === "string" ? this.tokenHash : await this.tokenHash(), "hex");
    if (!token || expected.length !== actual.length || !timingSafeEqual(actual, expected)) {
      throw new HttpException(
        { type: "https://alter.dev/problems/unauthorized", title: "Unauthorized", status: 401, instance: "/internal/deletion" },
        401,
      );
    }
  }
}

class MissingField extends Error {}

function required(value: string | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new MissingField(`${name} must be a non-empty string`);
  return value;
}

function problem(operation: string, status: 400 | 500, errorCode: string, detail: string): ProblemDetails {
  return {
    type: `https://alter.dev/problems/${errorCode.toLowerCase().replaceAll("_", "-")}`,
    title: status === 400 ? "Bad Request" : "Internal Server Error",
    status,
    detail,
    instance: `/internal/deletion/${operation}`,
    error_code: errorCode,
    trace_id: prefixedUuidV7("trc"),
    request_id: prefixedUuidV7("req"),
    retryable: status === 500,
    field_errors: [],
    documentation_key: "deletion.platform",
  };
}

function prefixedUuidV7(prefix: "trc" | "req"): `${typeof prefix}_${string}` {
  const id = randomBytes(16).toString("hex");
  return `${prefix}_${id.slice(0, 8)}-${id.slice(8, 12)}-7${id.slice(13, 16)}-8${id.slice(17, 20)}-${id.slice(20, 32)}`;
}
