import {
  ConnectorTypeSchema,
  ConnectionsRequiredSchema,
  parseConnectionSecretReference,
  type CompiledDag,
  type ConnectionsRequired,
  type ConnectionRegistrySnapshot,
} from "@alterx/contracts";
import { CompilerValidationError } from "../compiler/dag-builder";
import type { OrchestrationTransactionLike } from "../project-read/project-read.service";

export class CompilerConnectionsRequiredError extends Error {
  readonly result: ConnectionsRequired;
  constructor(result: ConnectionsRequired) {
    const parsed = ConnectionsRequiredSchema.parse(result);
    super(JSON.stringify(parsed));
    this.name = "CompilerConnectionsRequiredError";
    this.result = parsed;
  }
}

/** One workspace snapshot and one batch for every compile entry point. */
export async function preflightConnections(
  tx: OrchestrationTransactionLike,
  tenantId: string,
  workflowId: string,
  dag: CompiledDag,
  suppliedWorkspaceId?: string,
): Promise<void> {
  const required = dag.nodes.filter(node => node.config["required_connector"] !== undefined ||
    (typeof node.config["credential_ref"] === "string" && node.config["credential_ref"].startsWith("/alter/integrations/")));
  if (required.length === 0) return;
  const workspaceId = suppliedWorkspaceId ?? (await tx.query<{ workspace_id: string }>(
    "SELECT workspace_id FROM workflows WHERE tenant_id=$1 AND id=$2",
    [tenantId, workflowId],
  )).rows[0]?.workspace_id;
  if (!workspaceId) throw new CompilerValidationError("workflow is not visible for connection preflight");
  const records = (await tx.query<ConnectionRegistrySnapshot>(
    "SELECT tenant_id, workspace_id, connection_id, connector_type, status, secret_ref, source_revision FROM connection_registry WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY connector_type, connection_id FOR SHARE",
    [tenantId, workspaceId],
  )).rows;
  const gaps = new Map<string, ConnectionsRequired["missing_connections"][number]>();
  const selected: { node: CompiledDag["nodes"][number]; reference: string }[] = [];
  for (const node of required) {
    const declaration = ConnectorTypeSchema.safeParse(node.config["required_connector"]);
    if (!declaration.success) throw new CompilerValidationError(`node ${node.key} needs a valid required_connector`);
    const connector = declaration.data;
    const reference = node.config["credential_ref"];
    const explicit = typeof reference === "string" && reference.startsWith("/alter/integrations/")
      ? parseConnectionSecretReference(reference) : undefined;
    if (typeof reference === "string" && reference.startsWith("/alter/integrations/") && !explicit) {
      throw new CompilerValidationError(`node ${node.key} has an invalid connection reference`);
    }
    if (explicit && (explicit.tenant_id !== tenantId || explicit.workspace_id !== workspaceId)) {
      throw new CompilerValidationError(`node ${node.key} has a connection reference outside its workflow scope`);
    }
    const matches = records.filter(record => record.connector_type === connector &&
      (explicit === undefined || record.connection_id === explicit.connection_id));
    const connected = matches.find(record => record.status === "connected");
    if (connected) {
      selected.push({ node, reference: connected.secret_ref });
      continue;
    }
    const reason = matches.length === 0 ? "missing" : "unavailable";
    const gap = gaps.get(connector);
    if (gap) {
      gap.node_keys.push(node.key);
      if (reason === "unavailable") gap.reason = reason;
    } else gaps.set(connector, { connector_type: connector, node_keys: [node.key], reason });
  }
  if (gaps.size > 0) throw new CompilerConnectionsRequiredError({
    type: "connections_required",
    missing_connections: [...gaps.values()].sort((a, b) => a.connector_type.localeCompare(b.connector_type)),
  });
  for (const { node, reference } of selected) node.config = { ...node.config, credential_ref: reference };
}
