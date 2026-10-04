CREATE TABLE IF NOT EXISTS "workspace_invitations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "workspace_id" uuid NOT NULL,
  "email" text NOT NULL CHECK (email=lower(btrim(email)) AND length(email) BETWEEN 3 AND 320),
  "role" text NOT NULL CHECK (role IN ('admin','editor','operator','approver','viewer')),
  "status" text DEFAULT 'delivery_failed' NOT NULL CHECK (status IN ('delivering','pending','delivery_failed','accepted','revoked','expired')),
  "invited_by" uuid NOT NULL REFERENCES "users"("id"),
  "provider_org_ref" text NOT NULL,
  "delivery_attempt_id" uuid,
  "provider_invitation_id" text,
  "provider_ticket_hash" text CHECK (provider_ticket_hash IS NULL OR provider_ticket_hash ~ '^[a-f0-9]{64}$'),
  "expires_at" timestamptz DEFAULT (now()+interval '7 days') NOT NULL,
  "accepted_by" uuid REFERENCES "users"("id"),
  "accepted_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "workspace_invitations_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "workspaces"("tenant_id","id"),
  CONSTRAINT "workspace_invitations_pending_delivery_check" CHECK (status<>'pending' OR (provider_invitation_id IS NOT NULL AND provider_ticket_hash IS NOT NULL)),
  CONSTRAINT "workspace_invitations_accepted_check" CHECK (status<>'accepted' OR (accepted_by IS NOT NULL AND accepted_at IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_invitations_pending_email_unique" ON "workspace_invitations" ("tenant_id","workspace_id","email") WHERE status IN ('pending','delivering');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_invitations_ticket_unique" ON "workspace_invitations" ("provider_ticket_hash") WHERE provider_ticket_hash IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "workspace_invitations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspace_invitations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS workspace_invitations_tenant_context_isolation ON "workspace_invitations";
--> statement-breakpoint
CREATE POLICY workspace_invitations_tenant_context_isolation ON "workspace_invitations" USING (tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid);
--> statement-breakpoint
DROP TRIGGER IF EXISTS workspace_invitations_set_updated_at ON "workspace_invitations";
--> statement-breakpoint
CREATE TRIGGER workspace_invitations_set_updated_at BEFORE UPDATE ON "workspace_invitations" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
DROP TRIGGER IF EXISTS workspace_invitations_prevent_tenant_id_update ON "workspace_invitations";
--> statement-breakpoint
CREATE TRIGGER workspace_invitations_prevent_tenant_id_update BEFORE UPDATE ON "workspace_invitations" FOR EACH ROW EXECUTE FUNCTION prevent_tenant_id_update();
--> statement-breakpoint
GRANT SELECT ON workspace_invitations TO platform_provisioner;
--> statement-breakpoint
-- Bootstrap returns only the scope of an exact provider-bound invitation.
CREATE OR REPLACE FUNCTION resolve_workspace_invitation(p_organization text,p_email text,p_ticket_hash text)
RETURNS TABLE ("invitationId" uuid,"tenantId" uuid,"workspaceId" uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT SET row_security TO off AS $$
  SELECT i.id,i.tenant_id,i.workspace_id FROM workspace_invitations i
    JOIN tenants t ON t.id=i.tenant_id JOIN workspaces w ON w.id=i.workspace_id AND w.tenant_id=i.tenant_id
   WHERE i.provider_org_ref=p_organization AND t.identity_org_ref=p_organization
     AND i.email=lower(btrim(p_email)) AND i.provider_ticket_hash=p_ticket_hash
     AND p_ticket_hash ~ '^[a-f0-9]{64}$' AND t.status='active' AND w.status='active'
$$;
--> statement-breakpoint
ALTER FUNCTION resolve_workspace_invitation(text,text,text) OWNER TO platform_provisioner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION resolve_workspace_invitation(text,text,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_workspace_invitation(text,text,text) TO platform_api;
--> statement-breakpoint
-- Organization-bound sign-in resolves existing membership, never a new grant.
CREATE OR REPLACE FUNCTION resolve_existing_organization_member(p_identity_ref text,p_organization text)
RETURNS TABLE ("userId" uuid,"tenantId" uuid,"workspaceId" uuid,"tenantRole" text,"workspaceRole" text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT SET row_security TO off AS $$
  SELECT u.id,tm.tenant_id,wm.workspace_id,tm.role,wm.role FROM users u
    JOIN tenant_members tm ON tm.user_id=u.id JOIN tenants t ON t.id=tm.tenant_id
    JOIN workspace_members wm ON wm.tenant_id=tm.tenant_id AND wm.user_id=u.id
    JOIN workspaces w ON w.id=wm.workspace_id AND w.tenant_id=tm.tenant_id
   WHERE u.identity_ref=p_identity_ref AND t.identity_org_ref=p_organization AND p_organization<>''
     AND u.status='active' AND t.status='active' AND w.status='active'
     AND NOT EXISTS(SELECT 1 FROM tenants duplicate WHERE duplicate.identity_org_ref=p_organization AND duplicate.id<>t.id)
   ORDER BY wm.created_at,wm.id LIMIT 1
$$;
--> statement-breakpoint
ALTER FUNCTION resolve_existing_organization_member(text,text) OWNER TO platform_provisioner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION resolve_existing_organization_member(text,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_existing_organization_member(text,text) TO platform_api;
