import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { ActorContext, RequireTenantRole, type ActorContextType } from "../rbac";
import { PublisherService } from "./publisher.service";
import { parseTransition, parseVerification } from "./publisher.validation";

@Controller("/api/v1/publisher")
export class PublisherController {
  constructor(private readonly publisher: PublisherService) {}
  @Post("verification") @RequireTenantRole("owner")
  verification(@Body() body: unknown, @ActorContext() actor: ActorContextType) { return this.publisher.submitVerification(actor.tenant_id, parseVerification(body, "/api/v1/publisher/verification")); }
  @Get("verification/status") @RequireTenantRole("member")
  verificationStatus(@ActorContext() actor: ActorContextType) { return this.publisher.verificationStatus(actor.tenant_id); }
  @Post("listings/:listingId/actions/submit") @RequireTenantRole("owner")
  submit(@Param("listingId") listingId: string, @ActorContext() actor: ActorContextType) { return this.publisher.submitListing(actor.tenant_id, listingId); }
  @Post("listings/:listingId/actions/transition") @RequireTenantRole("owner")
  transition(@Param("listingId") listingId: string, @Body() body: unknown, @ActorContext() actor: ActorContextType) { return this.publisher.transitionListing(actor.tenant_id, listingId, parseTransition(body, `/api/v1/publisher/listings/${listingId}/actions/transition`)); }
  @Get("earnings") @RequireTenantRole("member")
  earnings(@ActorContext() actor: ActorContextType) { return this.publisher.earnings(actor.tenant_id); }
  @Get("payouts") @RequireTenantRole("member")
  payouts(@ActorContext() actor: ActorContextType) { return this.publisher.payouts(actor.tenant_id); }
}
