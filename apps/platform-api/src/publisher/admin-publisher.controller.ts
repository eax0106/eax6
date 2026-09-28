import { Body, Controller, Get, Param, Post, Req } from "@nestjs/common";
import { RequireStaffRole } from "../rbac/decorators";
import type { RbacRequest } from "../rbac/types";
import { AdminPublisherService } from "./admin-publisher.service";
import { PublisherHttpError } from "./publisher.problem";
import { parseReview } from "./publisher.validation";

const BASE = "/api/v1/admin/publisher/verifications";
const roles = ["staff_admin", "staff_security"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Seller verification review for staff (task B2.4). Replaces the interim
 * tenant-owner route that was limited to one dogfooding tenant "until
 * Operations staff RBAC exists".
 */
@Controller(BASE)
export class AdminPublisherController {
  constructor(private readonly admin: AdminPublisherService) {}

  @Get()
  @RequireStaffRole(...roles)
  list() {
    return this.admin.listPending();
  }

  @Post(":tenantId/:submissionId/actions/review")
  @RequireStaffRole(...roles)
  review(
    @Param("tenantId") tenantId: string,
    @Param("submissionId") submissionId: string,
    @Body() body: unknown,
    @Req() request: RbacRequest,
  ) {
    const instance = `${BASE}/${tenantId}/${submissionId}/actions/review`;
    if (!UUID.test(tenantId) || !/^kyc_[A-Za-z0-9-]{1,120}$/.test(submissionId)) {
      throw new PublisherHttpError(400, "INVALID_PUBLISHER_REQUEST", "Invalid tenant or submission id", instance);
    }
    const staffUserId = request.staffActorContext?.staff_user_id;
    if (!staffUserId) {
      throw new PublisherHttpError(403, "STAFF_ACTOR_REQUIRED", "Authenticated staff actor required", instance);
    }
    return this.admin.review(tenantId, submissionId, staffUserId, parseReview(body, instance));
  }
}
