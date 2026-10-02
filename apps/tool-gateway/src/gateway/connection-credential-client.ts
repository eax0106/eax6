import { ConnectionCredentialLookupSchema, ConnectionRegistrySnapshotSchema, type ConnectionCredentialLookup } from "@alterx/contracts";
import { ToolGatewayCredentialMissingError } from "@alterx/adapters";

export async function resolveConnectionCredential(baseUrl: string, serviceToken: string, input: ConnectionCredentialLookup): Promise<string> {
  const query = ConnectionCredentialLookupSchema.parse(input);
  const response = await fetch(new URL("/internal/connections/resolve", baseUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${serviceToken}`, "content-type": "application/json" },
    body: JSON.stringify(query),
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 409) {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "error_code" in body && body.error_code === "CREDENTIAL_MISSING") throw new ToolGatewayCredentialMissingError();
  }
  if (!response.ok) throw new Error("Connection credential lookup failed");
  const record = ConnectionRegistrySnapshotSchema.parse(await response.json());
  if (record.status !== "connected" || record.secret_ref !== query.credential_ref || `ten_${record.tenant_id}` !== query.tenant_id) throw new ToolGatewayCredentialMissingError();
  return record.secret_ref;
}
