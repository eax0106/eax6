import { Injectable } from "@nestjs/common";
import { ConnectionRegistrySnapshotSchema, type ConnectionRegistrySnapshot } from "@alterx/contracts";
import { resolveRuntimeSecret } from "../identity/identity.module";

export function connectionRegistryClientFromEnvironment(environment: NodeJS.ProcessEnv = process.env): ConnectionRegistryClient {
  const baseUrl = environment.ENGINE_BASE_URL, reference = environment.CONNECTION_REGISTRY_SERVICE_TOKEN_REF;
  if (!baseUrl || !reference) throw new Error("Engine connection registry URL and service token reference must be configured");
  return new ConnectionRegistryClient(baseUrl, () => resolveRuntimeSecret(reference));
}

@Injectable()
export class ConnectionRegistryClient {
  constructor(private readonly baseUrl: string, private readonly resolveToken: () => Promise<string>,
    private readonly fetchImpl: typeof fetch = fetch) {}

  async upsert(snapshot: ConnectionRegistrySnapshot): Promise<void> {
    const record = ConnectionRegistrySnapshotSchema.parse(snapshot);
    const token = await this.resolveToken();
    if (!token) throw new Error("Connection registry authentication is not configured");
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}/internal/connections/upsert`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(record), signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Connection registry synchronization failed (${response.status})`);
    const result = await response.json() as { source_revision?: unknown } | null;
    if (!result || !Number.isInteger(result.source_revision) || Number(result.source_revision) < record.source_revision) {
      throw new Error("Connection registry returned an invalid revision");
    }
  }
}
