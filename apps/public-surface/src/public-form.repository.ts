import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import { HostedFormDefinitionSchema, type PublicFormTokenClaims } from "@alterx/contracts";

export class PublicFormRepository {
  constructor(private readonly store: PostgresOrchestrationStoreProvider) {}
  async verifyRuntimeRole(): Promise<void> {
    await this.store.withTenant("00000000-0000-7000-8000-000000000000", async tx => {
      const roles = await tx.query<{ role: string; rolsuper: boolean; rolbypassrls: boolean; broad_read: boolean; trigger_write: boolean; version_write: boolean; policies: number }>(
        `SELECT current_user AS role, rolsuper, rolbypassrls,
         has_table_privilege(current_user,'workflows','SELECT') AS broad_read,
         has_any_column_privilege(current_user,'triggers','UPDATE') AS trigger_write,
         has_any_column_privilege(current_user,'trigger_versions','UPDATE') AS version_write,
         (SELECT count(*)::int FROM pg_policies WHERE policyname IN ('public_forms_trigger_scope','public_forms_version_scope')
           AND permissive='RESTRICTIVE' AND 'public_surface'=ANY(roles)) AS policies
         FROM pg_roles WHERE rolname=current_user`);
      const row = roles.rows[0];
      if (!row || row.role !== "public_surface" || row.rolsuper || row.rolbypassrls || row.broad_read || row.trigger_write || row.version_write || row.policies !== 2) throw new Error("Public Surface requires its dedicated restricted database role and policies");
    });
  }
  async get(claims: PublicFormTokenClaims) {
    return this.store.withTenant(claims.tenantId.slice(4), async tx => {
      await tx.query("SELECT set_config('app.public_form_trigger_id',$1,true),set_config('app.public_form_version_id',$2,true)", [claims.triggerId, claims.triggerVersionId]);
      const result = await tx.query<{ workspace_id: string; version: number; config: Record<string, unknown> }>(
        `SELECT t.workspace_id, v.version, v.config FROM triggers t JOIN trigger_versions v
         ON v.tenant_id=t.tenant_id AND v.trigger_id=t.id
         WHERE t.tenant_id=$1 AND t.id=$2 AND v.id=$3 AND t.type='webhook'
         AND t.provider='alter_public_form' AND t.status='enabled' AND v.status='active'
         ORDER BY v.version DESC LIMIT 1`, [claims.tenantId.slice(4), claims.triggerId, claims.triggerVersionId]);
      const row = result.rows[0];
      if (!row) return null;
      const definition = HostedFormDefinitionSchema.safeParse(row.config.publicForm);
      const policy = row.config.dlqPolicy as { maxReceiveCount?: unknown } | undefined;
      const maximum = policy?.maxReceiveCount;
      if (!definition.success || typeof maximum !== "number" || !Number.isInteger(maximum) || maximum < 1 || maximum > 1000) return null;
      return { definition: definition.data, workspaceId: `ws_${row.workspace_id}`, version: row.version, dlqMaxReceiveCount: maximum };
    });
  }
}
