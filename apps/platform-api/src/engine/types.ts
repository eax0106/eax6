import type { JsonValue } from "@alterx/shared-clients";

export type EnginePath = `/api/v1/${string}`;

export interface EngineCallerContext {
  userId: string;
  tenantId: string;
  workspaceId: string;
  sessionId: string;
  authTime: number;
  roles: string[];
  permissions: string[];
  traceparent: string;
}

export interface EngineAuthorization {
  m2mAccessToken: string;
  actorToken: string;
}

export interface EngineResponse<TBody> {
  status: number;
  body: TBody;
  etag?: string;
  location?: string;
  requestId?: string;
  traceId?: string;
}

export interface EngineMutationOptions {
  idempotencyKey: string;
  ifMatch?: string;
  /**
   * Overrides the client's default request timeout for one call. Only routes
   * that wait on the planner set it; everything else keeps the short default,
   * which is what makes a genuinely unresponsive engine visible quickly.
   */
  timeoutMs?: number;
}

export interface EnginePatchOptions extends EngineMutationOptions {
  ifMatch: string;
}

export interface EnginePutOptions extends EngineMutationOptions {
  ifMatch?: string;
}

export interface EngineSseMessage {
  id?: string;
  event?: string;
  data: unknown;
}

export interface EngineEventStream {
  messages: AsyncIterable<EngineSseMessage>;
  close(): void;
}

export interface EngineStreamOptions {
  signal?: AbortSignal;
  lastEventId?: string;
}

export type EngineRequestBody = JsonValue;
