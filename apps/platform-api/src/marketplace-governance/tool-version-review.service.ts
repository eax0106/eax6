import { Injectable } from "@nestjs/common";
import { AdminAuditService } from "../admin-audit";
import { ToolVersionReviewRepository, type ToolVersionReviewInput } from "./tool-version-review.repository";

@Injectable()
export class ToolVersionReviewService {
  constructor(private readonly repository: ToolVersionReviewRepository, private readonly audit: AdminAuditService) {}
  list() { return this.repository.list(); }
  review(manifestId: string, versionId: string, staffUserId: string, input: ToolVersionReviewInput) {
    return this.repository.review(manifestId,versionId,staffUserId,input,tenantId => this.audit.record({
      tenantId,actorType:"admin",actorRef:staffUserId,action:`registry.first-version.${input.decision}`,
      targetType:"tool_version",targetRef:versionId,reasonCode:"staff_decision",scope:["registry:first-version-review",`scan:${input.scanReportId}`],
    }));
  }
}
