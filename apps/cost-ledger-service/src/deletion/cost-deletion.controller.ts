import { createHash, timingSafeEqual } from "node:crypto";
import { BadRequestException, Body, Controller, Get, Headers, Inject, InternalServerErrorException, Post, Query, UnauthorizedException } from "@nestjs/common";
import { Public } from "@alterx/auth";
import { CostDeletionService } from "./cost-deletion.service";

export const COST_DELETION_TOKEN_HASH = Symbol("COST_DELETION_TOKEN_HASH");

interface DeleteBody {
  readonly tenantId?: string;
  readonly manifestId?: string;
}

/**
 * The erasure provider audit-service's DeletionOrchestrator calls for cost_db
 * (D2, C3b). Internal only; the shared deletion service token is the boundary,
 * so the routes are public to the machine-token guard and check it themselves.
 */
@Public()
@Controller("internal/deletion")
export class CostDeletionController {
  constructor(
    private readonly service: CostDeletionService,
    @Inject(COST_DELETION_TOKEN_HASH) private readonly tokenHash: string,
  ) {}

  @Get("locate")
  locate(@Query("tenantId") tenantId?: string, @Headers("authorization") auth?: string) {
    this.authorize(auth);
    return this.run(() => this.service.locateSubjectData(required(tenantId, "tenantId")));
  }

  @Post("delete")
  delete(@Body() body: DeleteBody, @Headers("authorization") auth?: string) {
    this.authorize(auth);
    return this.run(() => this.service.deleteSubjectData(required(body?.tenantId, "tenantId"), required(body?.manifestId, "manifestId")));
  }

  @Post("verify")
  verify(@Body() body: DeleteBody, @Headers("authorization") auth?: string) {
    this.authorize(auth);
    return this.run(() => this.service.verifyDeletion(required(body?.tenantId, "tenantId"), required(body?.manifestId, "manifestId")));
  }

  @Post("retention")
  retention(@Headers("authorization") auth?: string) {
    this.authorize(auth);
    return this.run(() => this.service.applyRetentionPolicy());
  }

  @Get("subjects")
  subjects(@Headers("authorization") auth?: string) {
    this.authorize(auth);
    return this.run(() => this.service.listSubjectIds());
  }

  private async run<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error: unknown) {
      if (error instanceof Error && /must be (a )?(ten_|del_|a non-empty)/.test(error.message)) {
        throw new BadRequestException(error.message);
      }
      throw new InternalServerErrorException("Deletion request could not be completed.");
    }
  }

  private authorize(value: string | undefined): void {
    const token = value?.startsWith("Bearer ") ? value.slice(7) : "";
    const actual = createHash("sha256").update(token).digest();
    const expected = Buffer.from(this.tokenHash, "hex");
    if (!token || expected.length !== actual.length || !timingSafeEqual(actual, expected)) {
      throw new UnauthorizedException("Deletion credential is invalid.");
    }
  }
}

function required(value: string | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}
