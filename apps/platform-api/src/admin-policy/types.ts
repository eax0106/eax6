import type { PlanCommercial } from "../entitlements/plan-commercial";
import type { EntitlementLimits } from "../entitlements/types";
import type { PlanDefinitionAuditAction } from "../entitlements/plan-definition-store";

export interface PlanDefinitionView {
  plan: string;
  limits: EntitlementLimits;
  commercial?: PlanCommercial | null;
  updated_at: string;
  updated_by: string;
}

export interface PlanDefinitionAuditView {
  id: string;
  plan: string;
  action: PlanDefinitionAuditAction;
  limits: EntitlementLimits | null;
  commercial?: PlanCommercial | null;
  reason: string;
  staff_user_id: string;
  occurred_at: string;
}

/**
 * What the plan resolves to today, and where that came from -- the staff
 * console needs to distinguish "this plan has a staff-authored definition"
 * from "this plan still resolves through the deployed ConfigProvider".
 */
export interface PlanPolicyView {
  plan: string;
  limits: EntitlementLimits;
  commercial?: PlanCommercial | null;
  source: "plan_definition" | "config_provider";
  definition: PlanDefinitionView | null;
}

export interface UpsertPlanDefinitionInput {
  limits: EntitlementLimits;
  commercial?: PlanCommercial | null;
  reason: string;
}

export interface DeletePlanDefinitionInput {
  reason: string;
}
