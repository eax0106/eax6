import { Body, Controller, Get, Headers, Param, Post, Req, UseFilters } from "@nestjs/common";
import {
  MarketplaceGovernanceActionRequestSchema,
  MarketplaceGovernanceResourceTypeSchema,
} from "@alterx/contracts";
import { RequireStaffRole } from "../rbac/decorators";
import type { RbacRequest } from "../rbac/types";
import { MarketplaceGovernanceService } from "./marketplace-governance.service";
import { MarketplaceGovernanceExceptionFilter } from "./marketplace-governance-exception.filter";
import { MarketplaceGovernanceHttpError } from "./problem";
import { ToolVersionReviewService } from "./tool-version-review.service";
import { z } from "zod";

const roles = ["staff_admin", "staff_security"] as const;

@Controller("/api/v1/admin/marketplace/governance")
@UseFilters(MarketplaceGovernanceExceptionFilter)
export class MarketplaceGovernanceController {
  constructor(private readonly governance: MarketplaceGovernanceService, private readonly toolReviews: ToolVersionReviewService) {}

  @Get("tools/review-queue")
  @RequireStaffRole(...roles)
  toolReviewQueue() { return this.toolReviews.list(); }

  @Post("tools/:manifestId/versions/:versionId/review")
  @RequireStaffRole(...roles)
  reviewToolVersion(@Param("manifestId") manifestId: string, @Param("versionId") versionId: string,
    @Body() body: unknown, @Req() request: RbacRequest) {
    const instance = `/api/v1/admin/marketplace/governance/tools/${manifestId}/versions/${versionId}/review`;
    const input = z.object({ scanReportId:z.string().regex(/^scn_[0-9a-f-]{36}$/i), decision:z.enum(["approved","rejected"]), reason:z.string().trim().min(1).max(2000) }).strict().safeParse(body);
    if (!input.success || !/^tlm_[0-9a-f-]{36}$/i.test(manifestId) || !/^tlv_[0-9a-f-]{36}$/i.test(versionId)) throw new MarketplaceGovernanceHttpError(400,"VALIDATION_ERROR","Invalid tool version review",instance);
    const staffUserId = request.staffActorContext?.staff_user_id;
    if (!staffUserId) throw new MarketplaceGovernanceHttpError(401,"AUTHENTICATION_REQUIRED","Authenticated staff actor required",instance);
    return this.toolReviews.review(manifestId,versionId,staffUserId,input.data);
  }

  @Get()
  @RequireStaffRole(...roles)
  list() {
    return this.governance.list();
  }

  @Post(":resourceType/:id/actions/apply")
  @RequireStaffRole(...roles)
  act(
    @Param("resourceType") rawResourceType: string,
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RbacRequest,
    @Headers("if-match") ifMatch?: string,
  ) {
    const instance = `/api/v1/admin/marketplace/governance/${rawResourceType}/${id}/actions/apply`;
    const resourceType = MarketplaceGovernanceResourceTypeSchema.safeParse(rawResourceType);
    const input = MarketplaceGovernanceActionRequestSchema.safeParse(body);
    if (!resourceType.success || !input.success || !/^(lst|tlm)_[A-Za-z0-9-]+$/.test(id)) {
      throw new MarketplaceGovernanceHttpError(
        400,
        "VALIDATION_ERROR",
        "Invalid marketplace governance request",
        instance,
      );
    }
    const staffUserId = request.staffActorContext?.staff_user_id;
    if (!staffUserId) {
      throw new MarketplaceGovernanceHttpError(
        401,
        "AUTHENTICATION_REQUIRED",
        "Authenticated staff actor required",
        instance,
      );
    }
    return this.governance.act(resourceType.data, id, staffUserId, input.data, ifMatch);
  }
}
