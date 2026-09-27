export interface AdminUserView {
  id: string;
  email: string;
  display_name: string | null;
  status: "active" | "suspended";
  tenant_ids: string[];
  created_at: string;
  last_seen_at: string | null;
  active_sessions: number;
}

export interface AdminUserActionView {
  id: string;
  action: string;
  reason: string | null;
  staff_email: string;
  occurred_at: string;
}

export type UserAdminAction = "suspended" | "reinstated" | "sessions_revoked";
