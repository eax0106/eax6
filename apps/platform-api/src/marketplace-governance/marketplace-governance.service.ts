import { Injectable } from "@nestjs/common";
import type {
  MarketplaceGovernanceActionRequest,
  MarketplaceGovernanceItem,
  MarketplaceGovernanceResourceType,
} from "@alterx/contracts";
import { governanceAuditScope } from "./governance-history";
import { AdminAuditService } from "../admin-audit";
import {
  MarketplaceGovernanceInvalidActionError,
  MarketplaceGovernanceRepository,
  MarketplaceGovernanceUnavailableError,
} from "./marketplace-governance.repository";
import { MarketplaceGovernanceHttpError } from "./problem";

@Injectable()
export class MarketplaceGovernanceService {
  constructor(
    private readonly repository: MarketplaceGovernanceRepository,
    private readonly audit: AdminAuditService,
  ) {}

  async list(): Promise<MarketplaceGovernanceItem[]> {
    try {
      return await this.repository.list();
    } catch (error) {
      this.translate(error, "/api/v1/admin/marketplace/governance");
    }
  }

  async act(
    resourceType: MarketplaceGovernanceResourceType,
    id: string,
    staffUserId: string,
    input: MarketplaceGovernanceActionRequest,
    ifMatch?: string,
  ): Promise<MarketplaceGovernanceItem> {
    const instance = `/api/v1/admin/marketplace/governance/${resourceType}/${id}/actions/apply`;
    let item: MarketplaceGovernanceItem | undefined;
    try {
      item = await this.repository.act(resourceType, id, input, {
        actorRef: staffUserId, ifMatch,
        audit: async reviewed => this.audit.record({
          ...(reviewed.tenant_id ? {tenantId: reviewed.tenant_id} : {}),
          actorType: "admin", actorRef: staffUserId, action: `marketplace.governance.${input.action}`,
          targetType: resourceType, targetRef: id, reasonCode: "staff_decision", scope: governanceAuditScope(reviewed),
        }),
      });
    } catch (error) {
      this.translate(error, instance);
    }
    if (!item) {
      throw new MarketplaceGovernanceHttpError(
        404,
        "MARKETPLACE_GOVERNANCE_RESOURCE_NOT_FOUND",
        "Marketplace governance resource was not found",
        instance,
      );
    }
    return item;
  }

  private translate(error: unknown, instance: string): never {
    if (error instanceof MarketplaceGovernanceUnavailableError) {
      throw new MarketplaceGovernanceHttpError(
        503,
        "MARKETPLACE_GOVERNANCE_UNAVAILABLE",
        error.message,
        instance,
      );
    }
    if (error instanceof MarketplaceGovernanceInvalidActionError) {
      throw new MarketplaceGovernanceHttpError(
        400,
        "MARKETPLACE_GOVERNANCE_INVALID_ACTION",
        error.message,
        instance,
      );
    }
    throw error;
  }
}
