import { z } from "zod";
import { isConnectorId } from "./connectors";
import type { ConnectorId, ConnectorTenantConfig } from "./connectors";
import { IntegrationHttpError } from "./problem";
import type {
  IntegrationActivityQuery,
  OAuthAuthorizeInput,
  OAuthCallbackInput,
} from "./types";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const zendeskConfig = z.object({
  subdomain: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/i),
}).strict();
const salesforceConfig = z.object({
  login_host: z.string().refine(
    (value) => value === "login.salesforce.com" || value === "test.salesforce.com" || /^[a-z0-9][a-z0-9.-]*\.(?:my|sandbox\.my)\.salesforce\.com$/i.test(value),
    "Expected login.salesforce.com, test.salesforce.com, or Salesforce My Domain host",
  ),
}).strict();
const shopifyConfig = z.object({
  shop_domain: z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i),
}).strict();
const m365Config = z.object({
  tenant: z.union([
    z.literal("common"),
    z.string().regex(uuidPattern, "Expected common or Microsoft tenant UUID"),
  ]),
}).strict();

const callbackSchema: z.ZodType<OAuthCallbackInput> = z
  .object({
    code: z.string().min(1),
    state: z.string().min(1),
  })
  .strict();

const activityQuerySchema: z.ZodType<IntegrationActivityQuery> = z
  .object({
    cursor: z.string().regex(uuidPattern, "Invalid activity cursor").optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export function parseConnectorId(value: string, instance: string): ConnectorId {
  if (!isConnectorId(value)) {
    throw validationError(instance, [
      { field: "connector", message: `Unsupported connector: ${value}` },
    ]);
  }
  return value;
}

export function parseConnectionId(value: string, instance: string): string {
  if (!uuidPattern.test(value)) {
    throw validationError(instance, [
      { field: "connectionId", message: "Invalid connectionId" },
    ]);
  }
  return value;
}

export function parseOAuthAuthorizeInput(
  value: unknown,
  connector: ConnectorId,
  instance: string,
): OAuthAuthorizeInput {
  const base = z.object({ redirect_uri: z.url(), tenant_config: z.unknown().optional(), connection_id: z.string().regex(uuidPattern).optional() }).strict();
  const parsed = parse(base, value, instance);
  const tenantConfig = parsed.connection_id && parsed.tenant_config === undefined
    ? undefined : parseTenantConfig(connector, parsed.tenant_config, instance);
  return {
    redirect_uri: parsed.redirect_uri,
    ...(parsed.connection_id ? { connection_id: parsed.connection_id } : {}),
    ...(tenantConfig ? { tenant_config: tenantConfig } : {}),
  };
}

function parseTenantConfig(
  connector: ConnectorId,
  value: unknown,
  instance: string,
): ConnectorTenantConfig | undefined {
  if (value === undefined) {
    if (["zendesk", "salesforce", "shopify", "m365"].includes(connector)) {
      throw validationError(instance, [
        {
          field: "tenant_config",
          message: `Tenant configuration required for ${connector}`,
        },
      ]);
    }
    return undefined;
  }

  switch (connector) {
    case "zendesk":
      return { connector, ...parse(zendeskConfig, value, instance) };
    case "salesforce":
      return { connector, ...parse(salesforceConfig, value, instance) };
    case "shopify":
      return { connector, ...parse(shopifyConfig, value, instance) };
    case "m365":
      return { connector, ...parse(m365Config, value, instance) };
    default:
      throw validationError(instance, [
        {
          field: "tenant_config",
          message: `${connector} does not accept tenant configuration`,
        },
      ]);
  }
}

export function parseOAuthCallbackInput(
  value: unknown,
  instance: string,
): OAuthCallbackInput {
  return parse(callbackSchema, value, instance);
}

export function parseActivityQuery(
  value: unknown,
  instance: string,
): IntegrationActivityQuery {
  return parse(activityQuerySchema, value, instance);
}

function parse<T>(schema: z.ZodType<T>, value: unknown, instance: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw validationError(
    instance,
    parsed.error.issues.map((issue) => ({
      field: issue.path.join(".") || "body",
      message: issue.message,
    })),
  );
}

function validationError(
  instance: string,
  fieldErrors: Array<{ field: string; message: string }>,
): IntegrationHttpError {
  return new IntegrationHttpError(
    400,
    "INTEGRATION_VALIDATION_FAILED",
    "Integration request validation failed",
    instance,
    fieldErrors,
  );
}
