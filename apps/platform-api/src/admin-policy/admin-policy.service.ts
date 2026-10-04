import { Inject, Injectable, Logger } from "@nestjs/common";
import { AdminAuditService } from "../admin-audit";
import {
  CONFIG_PROVIDER,
  type ConfigProvider,
} from "../entitlements/config-provider.interface";
import {
  PLAN_DEFINITION_STORE,
  PlanDefinitionPreconditionError,
  type PlanDefinitionAuditRecord,
  type PlanDefinitionRecord,
  type PlanDefinitionStore,
} from "../entitlements/plan-definition-store";
import { AdminPolicyHttpError } from "./problem";
import type {
  DeletePlanDefinitionInput,
  PlanDefinitionAuditView,
  PlanDefinitionView,
  PlanPolicyView,
  UpsertPlanDefinitionInput,
} from "./types";

@Injectable()
export class AdminPolicyService {
  private readonly logger = new Logger(AdminPolicyService.name);

  constructor(
    @Inject(PLAN_DEFINITION_STORE)
    private readonly definitions: PlanDefinitionStore,
    @Inject(CONFIG_PROVIDER)
    private readonly config: ConfigProvider,
    private readonly audit: AdminAuditService,
  ) {}

  /**
   * Staff-authored definitions only. The deployed ConfigProvider exposes no
   * plan enumeration (`getEntitlementDefaults(plan)` is keyed lookup only),
   * so plans that still resolve from the baseline config cannot be listed
   * here -- read one by name instead.
   */
  async listDefinitions(): Promise<PlanDefinitionView[]> {
    return (await this.definitions.list()).map(toDefinitionView);
  }

  async getPolicy(plan: string): Promise<PlanPolicyView> {
    const instance = `/api/v1/admin/policy/plans/${plan}`;
    const definition = await this.definitions.find(plan);
    if (definition) {
      return {
        version: definition.updatedAt.toISOString(),
        plan,
        limits: definition.limits,
        source: "plan_definition",
        definition: toDefinitionView(definition),
      };
    }

    try {
      return {
        version: "absent",
        plan,
        limits: await this.config.getEntitlementDefaults(plan),
        source: "config_provider",
        definition: null,
      };
    } catch (error) {
      this.logger.warn(
        `No plan definition and no baseline config for plan ${plan}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw notFound(instance, plan);
    }
  }

  async upsert(
    plan: string,
    staffUserId: string,
    input: UpsertPlanDefinitionInput,
    ifMatch?: string,
  ): Promise<PlanDefinitionView> {
    const { record } = await preconditioned(()=>this.definitions.upsert(
      plan,
      input.limits,
      staffUserId,
      input.commercial,
      input.reason,
      {ifMatch:requiredIfMatch(ifMatch,plan),beforeCommit:created=>this.audit.record({
      actorType: "admin",
      actorRef: staffUserId,
      action: created ? "policy.plan.create" : "policy.plan.update",
      targetType: "plan",
      targetRef: plan,
      reasonCode: "staff_decision",
      scope: "entitlements:write",
      })},
    ),plan);
    return toDefinitionView(record);
  }

  async remove(
    plan: string,
    staffUserId: string,
    input: DeletePlanDefinitionInput,
    ifMatch?: string,
  ): Promise<void> {
    const instance = `/api/v1/admin/policy/plans/${plan}`;
    const removed=await preconditioned(()=>this.definitions.remove(plan,{ifMatch:requiredIfMatch(ifMatch,plan),
      staffUserId,auditReason:input.reason,beforeCommit:()=>this.audit.record({
      actorType: "admin",
      actorRef: staffUserId,
      action: "policy.plan.delete",
      targetType: "plan",
      targetRef: plan,
      reasonCode: "staff_decision",
      scope: "entitlements:write",
      })}),plan);
    if (!removed) throw notFound(instance, plan);
  }

  async history(plan: string, limit: number): Promise<PlanDefinitionAuditView[]> {
    return (await this.definitions.history(plan, limit)).map(toAuditView);
  }
}

function toDefinitionView(record: PlanDefinitionRecord): PlanDefinitionView {
  return {
    version: record.updatedAt.toISOString(),
    plan: record.plan,
    limits: record.limits,
    commercial: record.commercial ?? null,
    updated_at: record.updatedAt.toISOString(),
    updated_by: record.updatedBy,
  };
}

function requiredIfMatch(ifMatch:string|undefined,plan:string):string {
  if(!ifMatch)throw new AdminPolicyHttpError(428,"PRECONDITION_REQUIRED","If-Match header is required",`/api/v1/admin/policy/plans/${plan}`);
  return ifMatch;
}
async function preconditioned<T>(operation:()=>Promise<T>,plan:string):Promise<T>{
  try{return await operation();}catch(error){if(error instanceof PlanDefinitionPreconditionError)throw new AdminPolicyHttpError(error.status,error.status===428?"PRECONDITION_REQUIRED":"PRECONDITION_FAILED",error.message,`/api/v1/admin/policy/plans/${plan}`);throw error;}
}

function toAuditView(record: PlanDefinitionAuditRecord): PlanDefinitionAuditView {
  return {
    id: record.id,
    plan: record.plan,
    action: record.action,
    limits: record.limits,
    commercial: record.commercial ?? null,
    reason: record.reason,
    staff_user_id: record.staffUserId,
    occurred_at: record.occurredAt.toISOString(),
  };
}

function notFound(instance: string, plan: string): AdminPolicyHttpError {
  return new AdminPolicyHttpError(
    404,
    "ADMIN_POLICY_PLAN_NOT_FOUND",
    `No plan policy found for plan: ${plan}`,
    instance,
  );
}
