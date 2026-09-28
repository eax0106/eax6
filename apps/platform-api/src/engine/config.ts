import { z } from "zod";

const engineConfigSchema = z.object({
  ENGINE_BASE_URL: z.string().url(),
  ADS_CORE_BASE_URL: z.string().url(),
  COST_LEDGER_BASE_URL: z.string().url(),
  EVAL_FACADE_TOKEN_REF: z.string().min(1),
  DEPLOYMENT_ADMIN_SERVICE_TOKEN_REF: z.string().min(1),
  AUDIT_SERVICE_BASE_URL: z.string().url(),
  AUDIT_QUERY_SERVICE_TOKEN_REF: z.string().min(1),
  // ads-core authenticates its callers with the shared internal service
  // token, not an Auth0 M2M token (apps/ads-core/src/service_auth.py).
  ADS_CORE_SERVICE_TOKEN_REF: z.string().min(1).optional(),
  ENGINE_M2M_TOKEN_URL: z.string().url(),
  ENGINE_M2M_AUDIENCE: z.string().min(1),
  ENGINE_M2M_CLIENT_ID: z.string().min(1),
  ENGINE_M2M_CLIENT_SECRET_REF: z.string().min(1),
  ENGINE_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  // A few engine routes run the planner inline, which means two model calls
  // before they answer. Five seconds cannot cover that: creating a project
  // timed out every time while the engine went on to write the project, its
  // conversation, its plan and its first clarification, so the caller saw a
  // failure for work that had already succeeded.
  ENGINE_PLANNING_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(120_000),
});

export interface EngineConfig {
  baseUrl: string;
  adsCoreBaseUrl: string;
  costLedgerBaseUrl: string;
  evalFacadeTokenRef: string;
  deploymentAdminServiceTokenRef: string;
  auditServiceBaseUrl: string;
  auditQueryServiceTokenRef: string;
  adsCoreServiceTokenRef?: string;
  m2mTokenUrl: string;
  m2mAudience: string;
  m2mClientId: string;
  m2mClientSecretRef: string;
  requestTimeoutMs: number;
  planningTimeoutMs: number;
}

export function engineConfigFromEnvironment(
  environment: NodeJS.ProcessEnv,
): EngineConfig {
  const parsed = engineConfigSchema.safeParse(environment);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid Engine client environment: ${detail}`);
  }
  // Without it every knowledge call reaches ads-core with an M2M token it
  // does not accept, so production refuses to boot rather than 401 later.
  if (environment.NODE_ENV === "production" && parsed.data.ADS_CORE_SERVICE_TOKEN_REF === undefined) {
    throw new Error("Invalid Engine client environment: ADS_CORE_SERVICE_TOKEN_REF is required in production");
  }

  return {
    baseUrl: parsed.data.ENGINE_BASE_URL.replace(/\/+$/, ""),
    adsCoreBaseUrl: parsed.data.ADS_CORE_BASE_URL.replace(/\/+$/, ""),
    costLedgerBaseUrl: parsed.data.COST_LEDGER_BASE_URL.replace(/\/+$/, ""),
    evalFacadeTokenRef: parsed.data.EVAL_FACADE_TOKEN_REF,
    deploymentAdminServiceTokenRef: parsed.data.DEPLOYMENT_ADMIN_SERVICE_TOKEN_REF,
    auditServiceBaseUrl: parsed.data.AUDIT_SERVICE_BASE_URL.replace(/\/+$/, ""),
    auditQueryServiceTokenRef: parsed.data.AUDIT_QUERY_SERVICE_TOKEN_REF,
    ...(parsed.data.ADS_CORE_SERVICE_TOKEN_REF === undefined
      ? {}
      : { adsCoreServiceTokenRef: parsed.data.ADS_CORE_SERVICE_TOKEN_REF }),
    m2mTokenUrl: parsed.data.ENGINE_M2M_TOKEN_URL,
    m2mAudience: parsed.data.ENGINE_M2M_AUDIENCE,
    m2mClientId: parsed.data.ENGINE_M2M_CLIENT_ID,
    m2mClientSecretRef: parsed.data.ENGINE_M2M_CLIENT_SECRET_REF,
    requestTimeoutMs: parsed.data.ENGINE_REQUEST_TIMEOUT_MS,
    planningTimeoutMs: parsed.data.ENGINE_PLANNING_TIMEOUT_MS,
  };
}
