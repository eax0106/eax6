import { z } from "zod";
import { TenantIdSchema, RunIdSchema } from "./ids";

export const ConnectorTypeSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/);
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const ConnectionSecretReferenceSchema = z.string().regex(new RegExp(`^/alter/integrations/${uuid}/${uuid}/${uuid}$`));

export function parseConnectionSecretReference(reference: string): { tenant_id: string; workspace_id: string; connection_id: string } | undefined {
  if (!ConnectionSecretReferenceSchema.safeParse(reference).success) return undefined;
  const parts = reference.split("/");
  return { tenant_id: parts[3]!, workspace_id: parts[4]!, connection_id: parts[5]! };
}

export const MissingConnectionSchema = z.object({
  connector_type: ConnectorTypeSchema,
  node_keys: z.array(z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/i)).min(1).max(1000),
  reason: z.enum(["missing", "unavailable"]),
}).strict();
export const ConnectionsRequiredSchema = z.object({
  type: z.literal("connections_required"),
  missing_connections: z.array(MissingConnectionSchema).min(1).max(1000),
}).strict();
export type ConnectionsRequired = z.infer<typeof ConnectionsRequiredSchema>;

export const ConnectorTypeSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/);
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const ConnectionSecretReferenceSchema = z.string().regex(new RegExp(`^/alter/integrations/${uuid}/${uuid}/${uuid}$`));

export function parseConnectionSecretReference(reference: string): { tenant_id: string; workspace_id: string; connection_id: string } | undefined {
  if (!ConnectionSecretReferenceSchema.safeParse(reference).success) return undefined;
  const parts = reference.split("/");
  return { tenant_id: parts[3]!, workspace_id: parts[4]!, connection_id: parts[5]! };
}

export const MissingConnectionSchema = z.object({
  connector_type: ConnectorTypeSchema,
  node_keys: z.array(z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/i)).min(1).max(1000),
  reason: z.enum(["missing", "unavailable"]),
}).strict();
export const ConnectionsRequiredSchema = z.object({
  type: z.literal("connections_required"),
  missing_connections: z.array(MissingConnectionSchema).min(1).max(1000),
}).strict();
export type ConnectionsRequired = z.infer<typeof ConnectionsRequiredSchema>;

/** A platform connection snapshot. Credential material never crosses this boundary. */
export const ConnectionRegistrySnapshotSchema = z.object({
  tenant_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  connection_id: z.string().uuid(),
  connector_type: ConnectorTypeSchema,
  status: z.enum(["connected", "revoked", "error"]),
  secret_ref: z.string().max(512),
  source_revision: z.number().int().positive().max(2_147_483_647),
}).strict().superRefine((record, context) => {
  if (record.secret_ref !== `/alter/integrations/${record.tenant_id}/${record.workspace_id}/${record.connection_id}`) {
    context.addIssue({ code: "custom", path: ["secret_ref"], message: "Connection secret reference must match its tenant, workspace and connection" });
  }
});

export type ConnectionRegistrySnapshot = z.infer<typeof ConnectionRegistrySnapshotSchema>;

export const ConnectionCredentialLookupSchema = z.object({
  tenant_id: TenantIdSchema,
  run_id: RunIdSchema,
  credential_ref: ConnectionSecretReferenceSchema,
}).strict();
export type ConnectionCredentialLookup = z.infer<typeof ConnectionCredentialLookupSchema>;
