import { z } from "zod";

/** A platform connection snapshot. Credential material never crosses this boundary. */
export const ConnectionRegistrySnapshotSchema = z.object({
  tenant_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  connection_id: z.string().uuid(),
  connector_type: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
  status: z.enum(["connected", "revoked", "error"]),
  secret_ref: z.string().max(512),
  source_revision: z.number().int().positive().max(2_147_483_647),
}).strict().superRefine((record, context) => {
  if (record.secret_ref !== `/alter/integrations/${record.tenant_id}/${record.workspace_id}/${record.connection_id}`) {
    context.addIssue({ code: "custom", path: ["secret_ref"], message: "Connection secret reference must match its tenant, workspace and connection" });
  }
});

export type ConnectionRegistrySnapshot = z.infer<typeof ConnectionRegistrySnapshotSchema>;
