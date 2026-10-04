import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
  CreateSignupInput,
  ExistingSignup,
  SignupPersistence,
} from "./types";

export class PlatformDb implements SignupPersistence {
  constructor(private readonly pool: Pool) {}

  async findExisting(
    identityRef: string,
    tenantHint: string,
  ): Promise<ExistingSignup | null> {
    const validTenantHint = isUuid(tenantHint) ? tenantHint : null;
    const result = await this.pool.query<ExistingSignup>(
      "SELECT * FROM resolve_existing_signup($1, $2::uuid)",
      [identityRef, validTenantHint],
    );
    return result.rows[0] ?? null;
  }

  async resolveInvitation(organization: string, email: string, ticketHash: string): Promise<{ invitationId: string; tenantId: string; workspaceId: string } | null> {
    const result = await this.pool.query<{ invitationId: string; tenantId: string; workspaceId: string }>(
      "SELECT * FROM resolve_workspace_invitation($1,$2,$3)", [organization, email, ticketHash]);
    return result.rows[0] ?? null;
  }

  async resolveOrganizationMember(identityRef: string, organization: string): Promise<ExistingSignup | null> {
    const result = await this.pool.query<ExistingSignup>("SELECT * FROM resolve_existing_organization_member($1,$2)", [identityRef, organization]);
    return result.rows[0] ?? null;
  }

  async createSignup<T>(
    input: CreateSignupInput,
    beforeCommit: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.transaction(input.tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["identity:" + input.identityRef]);
      const existing = await client.query("SELECT 1 FROM users WHERE identity_ref=$1", [input.identityRef]);
      if (existing.rowCount) throw new Error("Identity already registered; retry sign-in");
      await client.query(
        `INSERT INTO tenants (id, name, status, identity_org_ref)
         VALUES ($1, $2, 'active', $3)`,
        [input.tenantId, input.tenantName, input.identityOrgRef],
      );
      await client.query(
        `INSERT INTO users (id, identity_ref, email, display_name, status)
         VALUES ($1, $2, $3, $4, 'active')`,
        [input.userId, input.identityRef, input.email, input.displayName ?? null],
      );
      await client.query(
        `INSERT INTO workspaces (id, tenant_id, name, status)
         VALUES ($1, $2, 'Default', 'active')`,
        [input.workspaceId, input.tenantId],
      );
      await client.query(
        `INSERT INTO tenant_members (id, tenant_id, user_id, role)
         VALUES (gen_random_uuid(), $1, $2, 'owner')`,
        [input.tenantId, input.userId],
      );
      await client.query(
        `INSERT INTO workspace_members
          (id, tenant_id, workspace_id, user_id, role)
         VALUES (gen_random_uuid(), $1, $2, $3, 'admin')`,
        [input.tenantId, input.workspaceId, input.userId],
      );
      return beforeCommit(client);
    });
  }

  async withTenant<T>(
    tenantId: string,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.transaction(tenantId, operation);
  }

  async queryTenant<T extends QueryResultRow>(
    tenantId: string,
    sql: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<T>(sql, values);
      return result.rows;
    });
  }

  private async transaction<T>(
    tenantId: string,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [
        tenantId,
      ]);
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
