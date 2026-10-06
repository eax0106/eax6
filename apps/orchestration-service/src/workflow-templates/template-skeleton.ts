import type { ConnectionRegistrySnapshot, ConnectionsRequired } from "@alterx/contracts";

type MissingConnection = ConnectionsRequired["missing_connections"][number];

/**
 * A template names what only the instantiating workspace knows with two
 * placeholders (see intelligence-service capability_registry/templates.py):
 *   "$alter:credential:<integration>" -> the tenant's reserved credential
 *       reference for a platform-wide or run-scoped integration;
 *   "$alter:connection:<connector>"   -> the id of the workspace's connected
 *       connection of that type, whose own secret reference the node then
 *       names explicitly.
 * Anything else in the skeleton is used exactly as reviewed.
 */
const CREDENTIAL = /^\$alter:credential:(email-send|web-search|knowledge-search|whatsapp-send)$/;
const CONNECTION = /^\$alter:connection:([a-z][a-z0-9._-]{0,63})$/;
const PLACEHOLDER = /^\$alter:/;

export class TemplatePlaceholderError extends Error {
  constructor(message: string) { super(message); this.name = "TemplatePlaceholderError"; }
}

export interface BoundSkeleton {
  readonly skeleton: Record<string, unknown>;
  readonly missing: MissingConnection[];
}

export function bindTemplateSkeleton(
  skeleton: Record<string, unknown>,
  scope: { readonly tenantId: string; readonly environment: string },
  connections: readonly ConnectionRegistrySnapshot[],
): BoundSkeleton {
  const missing = new Map<string, MissingConnection>();
  const bound = structuredClone(skeleton);
  const nodes = Array.isArray(bound["nodes"]) ? bound["nodes"] as Record<string, unknown>[] : [];
  for (const node of nodes) {
    const config = node["config"] as Record<string, unknown> | undefined;
    if (config === undefined) continue;
    const connector = typeof config["required_connector"] === "string" ? config["required_connector"] : undefined;
    let connection: ConnectionRegistrySnapshot | undefined;
    if (connector !== undefined) {
      const matches = connections.filter((record) => record.connector_type === connector);
      connection = matches.find((record) => record.status === "connected");
      if (connection === undefined) {
        const gap = missing.get(connector) ?? { connector_type: connector, node_keys: [], reason: matches.length === 0 ? "missing" : "unavailable" };
        gap.node_keys.push(String(node["key"]));
        missing.set(connector, gap);
      } else {
        config["credential_ref"] = connection.secret_ref;
      }
    }
    node["config"] = replace(config, (value) => {
      const credential = CREDENTIAL.exec(value);
      if (credential !== null) return `/alter/${scope.environment}/tenant/${scope.tenantId}/integration/${credential[1]}/default`;
      const wanted = CONNECTION.exec(value);
      if (wanted !== null) {
        if (wanted[1] !== connector) throw new TemplatePlaceholderError(`node ${String(node["key"])} names a connection it does not require`);
        return connection?.connection_id ?? value;
      }
      if (PLACEHOLDER.test(value)) throw new TemplatePlaceholderError(`node ${String(node["key"])} has an unknown placeholder`);
      return value;
    }) as Record<string, unknown>;
  }
  return { skeleton: bound, missing: [...missing.values()].sort((a, b) => a.connector_type.localeCompare(b.connector_type)) };
}

function replace(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map((item) => replace(item, map));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item, map)]));
  }
  return value;
}
