import { z } from "zod";

export const platformApiEnvSchema = z
  .object({
    DATABASE_URL: z.string().url(),
    PLATFORM_RETENTION_DATABASE_URL: z.string().url().optional(),
    MARKETPLACE_DATABASE_URL: z.string().url(),
    MARKETPLACE_SEARCH_CURSOR_SECRET: z.string().min(1),
    // D2: how long a deleted workspace stays restorable before it is erased.
    WORKSPACE_DELETION_WINDOW_DAYS: z.coerce.number().int().min(1).max(30).default(7),
    OPERATIONS_PLATFORM_DATABASE_URL: z.string().url().optional(),
    OPERATIONS_MARKETPLACE_DATABASE_URL: z.string().url().optional(),
    // Reserved for platform cache wiring in a later ticket.
    REDIS_ENDPOINT_PARAM: z.string().optional(),
    // Production DB wiring resolves through SecretsProvider in a later ticket.
    DATABASE_SECRET_REF: z.string().optional(),
    NODE_ENV: z.string().optional(),
    IDENTITY_PROVIDER: z.enum(["auth0", "google", "mock"]).default("mock"),
    AUTH0_DOMAIN: z.string().min(1).optional(),
    AUTH0_CLIENT_ID: z.string().min(1).optional(),
    AUTH0_CLIENT_SECRET_REF: z.string().min(1).optional(),
    AUTH0_M2M_CLIENT_ID: z.string().min(1).optional(),
    AUTH0_M2M_CLIENT_SECRET_REF: z.string().min(1).optional(),
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET_REF: z.string().min(1).optional(),
    SESSION_COOKIE_SIGNING_KEY_REF: z.string().min(1).optional(),
    EMAIL_PROVIDER: z.enum(["ses", "mock"]).default("mock"),
    SES_FROM_ADDRESS: z.string().min(1).optional(),
    SES_CREDENTIALS_SECRET_REF: z.string().min(1).optional(),
    SIGNING_KEY_PROVIDER: z.enum(["secrets", "mock"]).default("secrets"),
    RUNTIME_MODE: z.enum(["real", "mock"]).default("mock"),
    ACTOR_TOKEN_SIGNING_KEY_REF: z.string().min(1).optional(),
    // Deprecated alias for ALTER_CONFIG_SOURCE.
    PLATFORM_API_CONFIG_SOURCE: z.enum(["appconfig", "local-file"]).optional(),
    ALTER_CONFIG_SOURCE: z.enum(["appconfig", "local-file"]).default("local-file"),
    APPCONFIG_APP_ID: z.string().min(1).optional(),
    APPCONFIG_ENV_ID: z.string().min(1).optional(),
    APPCONFIG_PROFILE_ID: z.string().min(1).optional(),
    ENGINE_BASE_URL: z.string().url().optional(),
    ADS_CORE_BASE_URL: z.string().url().optional(),
    COST_LEDGER_BASE_URL: z.string().url().optional(),
    EVAL_FACADE_TOKEN_REF: z.string().min(1).optional(),
    DEPLOYMENT_ADMIN_SERVICE_TOKEN_REF: z.string().min(1).optional(),
    AUDIT_SERVICE_BASE_URL: z.string().url().optional(),
    AUDIT_SERVICE_GRPC_ADDRESS: z.string().min(1).optional(),
    AUDIT_QUERY_SERVICE_TOKEN_REF: z.string().min(1).optional(),
    ENGINE_M2M_TOKEN_URL: z.string().url().optional(),
    ENGINE_M2M_AUDIENCE: z.string().min(1).optional(),
    ENGINE_M2M_CLIENT_ID: z.string().min(1).optional(),
    ENGINE_M2M_CLIENT_SECRET_REF: z.string().min(1).optional(),
    ENGINE_REQUEST_TIMEOUT_MS: z.string().regex(/^[1-9]\d*$/).optional(),
    IDEMPOTENCY_TTL_SECONDS: z.string().regex(/^[1-9]\d*$/).optional(),
    RAZORPAY_KEY_ID_SECRET_REF: z.string().min(1).optional(),
    RAZORPAY_KEY_SECRET_SECRET_REF: z.string().min(1).optional(),
    RAZORPAY_WEBHOOK_SECRET_REF: z.string().min(1).optional(),
    STATUS_PAGE_PROVIDER: z.enum(["atlassian", "mock"]).default("mock"),
    STATUSPAGE_PAGE_ID: z.string().min(1).optional(),
    STATUSPAGE_API_TOKEN_SECRET_REF: z.string().min(1).optional(),
    MODEL_GATEWAY_ADMIN_BASE_URL: z.string().url().optional(),
    MODEL_GATEWAY_ADMIN_TOKEN_REF: z.string().min(1).optional(),
    MODEL_GATEWAY_ADMIN_TIMEOUT_MS: z.string().regex(/^[1-9]\d*$/).optional(),
    GITHUB_OAUTH_CLIENT_ID_SECRET_REF: z.string().min(1).optional(),
    GITHUB_OAUTH_CLIENT_SECRET_REF: z.string().min(1).optional(),
    GOOGLE_OAUTH_CLIENT_ID_SECRET_REF: z.string().min(1).optional(),
    GOOGLE_OAUTH_CLIENT_SECRET_REF: z.string().min(1).optional(),
    ZENDESK_OAUTH_CLIENT_ID_SECRET_REF: z.string().min(1).optional(),
    ZENDESK_OAUTH_CLIENT_SECRET_REF: z.string().min(1).optional(),
    SALESFORCE_OAUTH_CLIENT_ID_SECRET_REF: z.string().min(1).optional(),
    SALESFORCE_OAUTH_CLIENT_SECRET_REF: z.string().min(1).optional(),
    SHOPIFY_OAUTH_CLIENT_ID_SECRET_REF: z.string().min(1).optional(),
    SHOPIFY_OAUTH_CLIENT_SECRET_REF: z.string().min(1).optional(),
    X_OAUTH_CLIENT_ID_SECRET_REF: z.string().min(1).optional(),
    X_OAUTH_CLIENT_SECRET_REF: z.string().min(1).optional(),
    M365_OAUTH_CLIENT_ID_SECRET_REF: z.string().min(1).optional(),
    M365_OAUTH_CLIENT_SECRET_REF: z.string().min(1).optional(),
    OAUTH_STATE_TTL_SECONDS: z.string().regex(/^[1-9]\d*$/).optional(),
    AWS_REGION: z.string().min(1).optional(),
    MARKETPLACE_OBJECT_STORAGE_PROVIDER: z.enum(["s3", "mock"]).default("mock"),
    REGISTRY_SCAN_PROVIDER: z.enum(["sandbox", "mock"]).default("mock"),
  })
  .superRefine((env, context) => {
    if (env.RUNTIME_MODE === "real" && (!env.PLATFORM_RETENTION_DATABASE_URL ||
        new URL(env.PLATFORM_RETENTION_DATABASE_URL).username !== "platform_retention")) {
      context.addIssue({ code: "custom", path: ["PLATFORM_RETENTION_DATABASE_URL"],
        message: "PLATFORM_RETENTION_DATABASE_URL with platform_retention required in real mode" });
    }
    if (env.RUNTIME_MODE === "mock" && env.NODE_ENV === "production") {
      context.addIssue({
        code: "custom",
        path: ["RUNTIME_MODE"],
        message: "RUNTIME_MODE=mock is not allowed when NODE_ENV=production",
      });
    }
    if (env.SIGNING_KEY_PROVIDER === "secrets" && !env.ACTOR_TOKEN_SIGNING_KEY_REF) {
      context.addIssue({
        code: "custom",
        path: ["ACTOR_TOKEN_SIGNING_KEY_REF"],
        message: "ACTOR_TOKEN_SIGNING_KEY_REF required when SIGNING_KEY_PROVIDER=secrets",
      });
    }

    if (env.IDENTITY_PROVIDER === "auth0") {
      requireFields(
        env,
        context,
        [
          "AUTH0_DOMAIN",
          "AUTH0_CLIENT_ID",
          "AUTH0_CLIENT_SECRET_REF",
          "AUTH0_M2M_CLIENT_ID",
          "AUTH0_M2M_CLIENT_SECRET_REF",
          "SESSION_COOKIE_SIGNING_KEY_REF",
        ],
        "IDENTITY_PROVIDER=auth0",
      );
    }

    if (env.IDENTITY_PROVIDER === "google") {
      requireFields(
        env,
        context,
        ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET_REF", "SESSION_COOKIE_SIGNING_KEY_REF"],
        "IDENTITY_PROVIDER=google",
      );
    }

    if (env.EMAIL_PROVIDER === "ses") {
      requireFields(
        env,
        context,
        ["SES_FROM_ADDRESS", "SES_CREDENTIALS_SECRET_REF"],
        "EMAIL_PROVIDER=ses",
      );
    }

    if (env.ALTER_CONFIG_SOURCE === "appconfig") {
      requireFields(
        env,
        context,
        ["APPCONFIG_APP_ID", "APPCONFIG_ENV_ID", "APPCONFIG_PROFILE_ID"],
        "ALTER_CONFIG_SOURCE=appconfig",
      );
    }
    if (env.MARKETPLACE_OBJECT_STORAGE_PROVIDER === "s3" && !env.AWS_REGION) {
      context.addIssue({ code: "custom", path: ["AWS_REGION"], message: "AWS_REGION required when MARKETPLACE_OBJECT_STORAGE_PROVIDER=s3" });
    }
    if (env.REGISTRY_SCAN_PROVIDER === "sandbox") {
      context.addIssue({ code: "custom", path: ["REGISTRY_SCAN_PROVIDER"], message: "REGISTRY_SCAN_PROVIDER=sandbox is unavailable until SCAN-1" });
    }
    if (env.STATUS_PAGE_PROVIDER === "atlassian") {
      requireFields(
        env,
        context,
        ["STATUSPAGE_PAGE_ID", "STATUSPAGE_API_TOKEN_SECRET_REF"],
        "STATUS_PAGE_PROVIDER=atlassian",
      );
    }
    if (Boolean(env.MODEL_GATEWAY_ADMIN_BASE_URL) !== Boolean(env.MODEL_GATEWAY_ADMIN_TOKEN_REF)) {
      context.addIssue({
        code: "custom",
        path: [env.MODEL_GATEWAY_ADMIN_BASE_URL
          ? "MODEL_GATEWAY_ADMIN_TOKEN_REF"
          : "MODEL_GATEWAY_ADMIN_BASE_URL"],
        message: "MODEL_GATEWAY_ADMIN_BASE_URL and MODEL_GATEWAY_ADMIN_TOKEN_REF must be configured together",
      });
    }
    if (Boolean(env.OPERATIONS_PLATFORM_DATABASE_URL) !== Boolean(env.OPERATIONS_MARKETPLACE_DATABASE_URL)) {
      context.addIssue({
        code: "custom",
        path: [env.OPERATIONS_PLATFORM_DATABASE_URL
          ? "OPERATIONS_MARKETPLACE_DATABASE_URL"
          : "OPERATIONS_PLATFORM_DATABASE_URL"],
        message: "Operations source database URLs must be configured together",
      });
    }
  });

function requireFields<
  T extends Record<string, unknown>,
  K extends Extract<keyof T, string>,
>(env: T, context: z.RefinementCtx<T>, fields: readonly K[], condition: string): void {
  for (const field of fields) {
    if (!env[field]) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: `${field} required when ${condition}`,
        input: env,
      });
    }
  }
}

export type PlatformApiEnv = z.infer<typeof platformApiEnvSchema>;

let warnedLegacyMock = false;
let warnedPlatformAlias = false;

function warnOnce(message: string, alias: boolean): void {
  if (alias ? warnedPlatformAlias : warnedLegacyMock) return;
  if (alias) warnedPlatformAlias = true;
  else warnedLegacyMock = true;
  process.emitWarning(message, { type: "DeprecationWarning" });
}

export function platformApiConfigSource(
  env: NodeJS.ProcessEnv = process.env,
): "appconfig" | "local-file" {
  const alias = env.PLATFORM_API_CONFIG_SOURCE?.trim();
  if (alias === "appconfig" || alias === "local-file") {
    warnOnce("PLATFORM_API_CONFIG_SOURCE is deprecated; use ALTER_CONFIG_SOURCE.", true);
    return alias;
  }
  const source = env.ALTER_CONFIG_SOURCE?.trim();
  if (source === "appconfig" || source === "local-file") return source;
  if (source === "mock") {
    warnOnce("ALTER_CONFIG_SOURCE=mock is deprecated; use RUNTIME_MODE=mock.", false);
  }
  return "local-file";
}

// The canonical AppConfig identifier names are the long forms
// (APPCONFIG_APPLICATION_ID / APPCONFIG_ENVIRONMENT_ID /
// APPCONFIG_CONFIGURATION_PROFILE_ID), matching the internal field names every
// service uses. platform-api's schema and its consumers read the short forms
// (APPCONFIG_APP_ID / APPCONFIG_ENV_ID / APPCONFIG_PROFILE_ID), so this maps
// the long form onto the short form when the short form is absent. Both sets
// keep working; the long form wins when both are present.
const APPCONFIG_LONG_TO_SHORT: ReadonlyArray<readonly [string, string]> = [
  ["APPCONFIG_APPLICATION_ID", "APPCONFIG_APP_ID"],
  ["APPCONFIG_ENVIRONMENT_ID", "APPCONFIG_ENV_ID"],
  ["APPCONFIG_CONFIGURATION_PROFILE_ID", "APPCONFIG_PROFILE_ID"],
];

export function normalizeAppConfigIdentifiers(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const normalized: NodeJS.ProcessEnv = { ...env };
  for (const [longName, shortName] of APPCONFIG_LONG_TO_SHORT) {
    const longValue = env[longName]?.trim();
    if (longValue !== undefined && longValue.length > 0) {
      normalized[shortName] = longValue;
    }
  }
  return normalized;
}

export function validatePlatformApiEnv(env: NodeJS.ProcessEnv): PlatformApiEnv {
  const parsed = platformApiEnvSchema.safeParse({
    ...normalizeAppConfigIdentifiers(env),
    ALTER_CONFIG_SOURCE: platformApiConfigSource(env),
  });

  if (!parsed.success) {
    const formatted = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid platform-api environment: ${formatted}`);
  }

  return parsed.data;
}
