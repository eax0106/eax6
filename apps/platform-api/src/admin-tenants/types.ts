import type { EntitlementLimits } from "../entitlements/types";

export interface AdminTenantView {
  id: string;
  name: string;
  status: string;
  region: string;
  identity_org_ref: string | null;
  created_at: string;
}

export interface AdminTenantDetailView extends AdminTenantView {
  entitlement: {
    plan: string;
    access_state: string;
    limits: EntitlementLimits;
  };
}

/** One append-only staff action on a tenant (tenant_admin_actions), newest first. */
export interface AdminTenantActionView {
  id: string;
  action: string;
  reason: string | null;
  staff_email: string;
  occurred_at: string;
}

export interface ProvisionTenantInput {
  name: string;
  identity_org_ref: string;
  region?: string;
  plan: string;
}

export interface SuspendTenantInput {
  reason: string;
}

export interface EntitlementOverrideInput {
  plan?: string;
  limits?: Partial<EntitlementLimits>;
  reason: string;
}
