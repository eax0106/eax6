import type {
  ActorTokenClaims,
  ProblemDetails,
  SystemActorTokenClaims,
} from "@alterx/contracts";

export type SessionGatewayErrorCode =
  | "AUTH_INVALID_M2M_TOKEN"
  | "AUTH_MISSING_ACTOR_TOKEN"
  | "AUTH_INVALID_ACTOR_TOKEN"
  | "AUTH_ACTOR_TOKEN_LIFETIME_EXCEEDED"
  | "AUTH_ACTOR_TOKEN_EXPIRED"
  | "AUTH_ACTOR_TOKEN_REPLAY"
  | "AUTH_SYSTEM_PRINCIPAL_READ_ONLY";

export interface ActorContext {
  /**
   * `system` is a platform background job (D1, `system:platform-jobs`): no
   * user, no workspace, one tenant, read-only. It is a third value on purpose:
   * code that grants a `service` actor anything (a service-asserted tenant, for
   * one) must never match it.
   */
  readonly actor_type: "user" | "service" | "system";
  readonly user_id: string | null;
  readonly tenant_id: string;
  readonly workspace_id: string | null;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly session_id: string | null;
  readonly jti: string | null;
}

export interface JsonWebKey {
  readonly kty: string;
  readonly kid?: string;
  readonly use?: string;
  readonly alg?: string;
  readonly n?: string;
  readonly e?: string;
}

export interface JsonWebKeySet {
  readonly keys: readonly JsonWebKey[];
}

export interface ReplayStore {
  setIfAbsent(key: string, ttlSeconds: number): Promise<boolean>;
}

export interface TenantTransaction {
  query(
    statement: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly unknown[]; readonly rowCount: number }>;
}

export interface TenantDatabaseScope {
  withTenant<T>(
    tenantId: string,
    operation: (transaction: TenantTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface IdentityTenantGatewayRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly method?: string;
  readonly url?: string;
  actorContext?: ActorContext;
  /** Actor JWT expiry captured during initial validation; stream endpoints close at this instant. */
  actorTokenExpiresAtMs?: number;
  withTenantDatabase?: <T>(
    operation: (transaction: TenantTransaction) => Promise<T>,
  ) => Promise<T>;
}

export interface IdentityTenantGatewayResponse {
  header?(name: string, value: string): unknown;
  setHeader?(name: string, value: string): unknown;
}

export interface ValidatedMachineToken {
  readonly claims: Readonly<Record<string, unknown>>;
  readonly serviceActor: ActorContext | null;
}

export class SessionGatewayAuthError extends Error {
  constructor(readonly errorCode: SessionGatewayErrorCode) {
    super(errorCode);
    this.name = "SessionGatewayAuthError";
  }
}

export interface ActorTokenValidationResult {
  readonly claims: ActorTokenClaims | SystemActorTokenClaims;
  readonly actorContext: ActorContext;
}

export type ProblemBody = ProblemDetails;
