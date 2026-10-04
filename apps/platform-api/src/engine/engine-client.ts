import { Inject, Injectable, Logger } from "@nestjs/common";
import type { EngineConfig } from "./config";
import {
  ENGINE_AUTH_PROVIDER,
  type EngineAuthProvider,
} from "./auth";
import {
  EngineProblemError,
  engineProblemFromResponse,
  upstreamProblem,
} from "./problem";
import type {
  EngineCallerContext,
  EngineEventStream,
  EngineMutationOptions,
  EnginePatchOptions,
  EnginePutOptions,
  EnginePath,
  EngineRequestBody,
  EngineResponse,
  EngineSseMessage,
  EngineStreamOptions,
} from "./types";

export const ENGINE_CONFIG = Symbol("ENGINE_CONFIG");

const logger = new Logger("EngineClient");

/**
 * Authorizing a call mints two tokens locally -- the Auth0 M2M access token and
 * a per-actor token -- before any request leaves the process. When that step
 * fails the caller still receives UPSTREAM_SERVICE_ERROR, which names the one
 * component that is definitely not at fault, and the cause was discarded
 * entirely. Keep the opaque problem for the caller; keep the cause for the
 * operator, the same way `internalError` does for the gRPC transports.
 */
function authorizationFailed(error: unknown, path: EnginePath): EngineProblemError {
  logger.error(
    `Engine authorization failed before calling ${path}`,
    error instanceof Error ? error.stack : String(error),
  );
  return new EngineProblemError(upstreamProblem(502, path, "UPSTREAM_SERVICE_ERROR"));
}

type EngineMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface RequestOptions {
  body?: EngineRequestBody;
  idempotencyKey?: string;
  ifMatch?: string;
  timeoutMs?: number;
}

@Injectable()
export class EngineClient {
  constructor(
    @Inject(ENGINE_CONFIG) private readonly config: EngineConfig,
    @Inject(ENGINE_AUTH_PROVIDER)
    private readonly authProvider: EngineAuthProvider,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly retryDelay: (milliseconds: number) => Promise<void> = delay,
    private readonly resolveSecret?: (reference: string) => Promise<string>,
  ) {}

  /**
   * ads-core authenticates the shared internal service token, not an Auth0
   * M2M token. When the reference is configured, knowledge calls carry that
   * token as their bearer; the actor token still rides alongside.
   */
  async #adsBearer(authorization: { m2mAccessToken: string; actorToken: string }): Promise<string> {
    if (this.config.adsCoreServiceTokenRef === undefined || this.resolveSecret === undefined) {
      return `Bearer ${authorization.m2mAccessToken}`;
    }
    return `Bearer ${await this.resolveSecret(this.config.adsCoreServiceTokenRef)}`;
  }

  get<TResponse>(
    path: EnginePath,
    context: EngineCallerContext,
  ): Promise<EngineResponse<TResponse>> {
    return this.request("GET", path, context);
  }

  post<TRequest extends EngineRequestBody, TResponse>(
    path: EnginePath,
    body: TRequest,
    context: EngineCallerContext,
    options: EngineMutationOptions,
  ): Promise<EngineResponse<TResponse>> {
    return this.request("POST", path, context, {
      body,
      idempotencyKey: options.idempotencyKey,
      ...(options.ifMatch === undefined ? {} : { ifMatch: options.ifMatch }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  }

  patch<TRequest extends EngineRequestBody, TResponse>(
    path: EnginePath,
    body: TRequest,
    context: EngineCallerContext,
    options: EnginePatchOptions,
  ): Promise<EngineResponse<TResponse>> {
    return this.request("PATCH", path, context, {
      body,
      idempotencyKey: options.idempotencyKey,
      ifMatch: options.ifMatch,
    });
  }

  put<TRequest extends EngineRequestBody, TResponse>(
    path: EnginePath,
    body: TRequest,
    context: EngineCallerContext,
    options: EnginePutOptions,
  ): Promise<EngineResponse<TResponse>> {
    return this.request("PUT", path, context, {
      body,
      idempotencyKey: options.idempotencyKey,
      ...(options.ifMatch === undefined ? {} : { ifMatch: options.ifMatch }),
    });
  }

  delete<TResponse>(
    path: EnginePath,
    context: EngineCallerContext,
    options: EnginePutOptions,
  ): Promise<EngineResponse<TResponse>> {
    return this.request("DELETE", path, context, {
      idempotencyKey: options.idempotencyKey,
      ...(options.ifMatch === undefined ? {} : { ifMatch: options.ifMatch }),
    });
  }

  async queryAds<TRequest extends object, TResponse>(
    body: TRequest,
    context: EngineCallerContext,
  ): Promise<EngineResponse<TResponse>> {
    const instance = "/api/v1/ads/query";
    let authorization;
    try {
      authorization = await this.authProvider.authorize(context);
    } catch {
      throw new EngineProblemError(
        upstreamProblem(502, instance, "UPSTREAM_SERVICE_ERROR"),
      );
    }

    try {
      const response = await this.fetchWithTimeout(
        `${this.config.adsCoreBaseUrl}/ads/query`,
        {
          method: "POST",
          headers: {
            ...requestHeaders(context, authorization, {
              body: body as EngineRequestBody,
            }),
            Authorization: await this.#adsBearer(authorization),
            "X-Alter-Tenant-Id": context.tenantId.startsWith("ten_") ? context.tenantId : `ten_${context.tenantId}`,
            "X-Alter-Workspace-Id": context.workspaceId,
            "X-Alter-Requester": context.userId,
          },
          body: JSON.stringify({
            ...body,
            tenant_id: context.tenantId.startsWith("ten_") ? context.tenantId : `ten_${context.tenantId}`,
            workspace_id: context.workspaceId,
            requester: context.userId,
          }),
        },
      );
      if (response.ok) return responseBody<TResponse>(response);
      throw new EngineProblemError(
        await engineProblemFromResponse(response, instance),
      );
    } catch (error) {
      if (error instanceof EngineProblemError) throw error;
      const timeout = isAbortError(error);
      throw new EngineProblemError(
        upstreamProblem(
          timeout ? 504 : 502,
          instance,
          timeout ? "UPSTREAM_TIMEOUT" : "UPSTREAM_SERVICE_ERROR",
        ),
      );
    }
  }

  async stream(
    path: EnginePath,
    context: EngineCallerContext,
    options: EngineStreamOptions = {},
  ): Promise<EngineEventStream> {
    assertEnginePath(path);
    let authorization;
    try {
      authorization = await this.authProvider.authorize(context);
    } catch (error) {
      throw authorizationFailed(error, path);
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });

    try {
      const response = await this.openGetStream(
        `${this.config.baseUrl}${path}`,
        {
          method: "GET",
          headers: {
            ...requestHeaders(context, authorization, {}),
            Accept: "text/event-stream, application/problem+json",
            ...(options.lastEventId
              ? { "Last-Event-ID": options.lastEventId }
              : {}),
          },
          signal: controller.signal,
        },
        path,
      );
      if (!response.body) {
        throw new EngineProblemError(
          upstreamProblem(502, path, "UPSTREAM_SERVICE_ERROR"),
        );
      }

      return {
        messages: parseSse(response.body),
        close: () => {
          options.signal?.removeEventListener("abort", abort);
          controller.abort();
        },
      };
    } catch (error) {
      options.signal?.removeEventListener("abort", abort);
      if (error instanceof EngineProblemError) {
        throw error;
      }
      throw new EngineProblemError(
        upstreamProblem(
          isAbortError(error) ? 504 : 502,
          path,
          isAbortError(error) ? "UPSTREAM_TIMEOUT" : "UPSTREAM_SERVICE_ERROR",
        ),
      );
    }
  }

  /**
   * Knowledge (`/api/v1/ads/*`) lives in ads-core, not the orchestration
   * engine. Every such call goes to ads-core's own `/ads/*` routes with the
   * tenant, workspace and requester headers it scopes by -- the same way
   * `queryAds` has always reached it. Sending them to the engine base URL
   * reached no route at all.
   */
  #target(
    path: EnginePath,
    context: EngineCallerContext,
  ): { readonly url: string; readonly headers: Record<string, string>; readonly ads: boolean } {
    if (!path.startsWith("/api/v1/ads/")) {
      return { url: `${this.config.baseUrl}${path}`, headers: {}, ads: false };
    }
    return {
      ads: true,
      url: `${this.config.adsCoreBaseUrl}${path.slice("/api/v1".length)}`,
      headers: {
        "X-Alter-Tenant-Id": context.tenantId.startsWith("ten_") ? context.tenantId : `ten_${context.tenantId}`,
        "X-Alter-Workspace-Id": context.workspaceId,
        "X-Alter-Requester": context.userId,
      },
    };
  }

  private async request<TResponse>(
    method: EngineMethod,
    path: EnginePath,
    context: EngineCallerContext,
    options: RequestOptions = {},
  ): Promise<EngineResponse<TResponse>> {
    assertEnginePath(path);
    const attempts = method === "GET" ? 2 : 1;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      // Actor tokens are single-use (replay-protected), so a retry must mint
      // a fresh one -- reusing the same token across a GET retry always trips
      // AUTH_ACTOR_TOKEN_REPLAY on the second attempt.
      let authorization;
      try {
        authorization = await this.authProvider.authorize(context);
      } catch (error) {
        throw authorizationFailed(error, path);
      }
      try {
        const target = this.#target(path, context);
        const response = await this.fetchWithTimeout(
          target.url,
          {
            method,
            headers: {
              ...requestHeaders(context, authorization, options),
              ...target.headers,
              ...(target.ads ? { Authorization: await this.#adsBearer(authorization) } : {}),
            },
            ...(options.body === undefined
              ? {}
              : { body: JSON.stringify(options.body) }),
          },
          options.timeoutMs,
        );

        if (response.ok) {
          return responseBody<TResponse>(response);
        }

        if (
          method === "GET" &&
          attempt === 0 &&
          isRetryableStatus(response.status)
        ) {
          await this.retryDelay(25);
          continue;
        }

        const problem = await engineProblemFromResponse(response, path);
        throw new EngineProblemError(problem);
      } catch (error) {
        if (error instanceof EngineProblemError) {
          throw error;
        }

        if (method === "GET" && attempt === 0) {
          await this.retryDelay(25);
          continue;
        }

        const timeout = isAbortError(error);
        throw new EngineProblemError(
          upstreamProblem(
            timeout ? 504 : 502,
            path,
            timeout ? "UPSTREAM_TIMEOUT" : "UPSTREAM_SERVICE_ERROR",
          ),
        );
      }
    }

    throw new Error("Engine request exhausted without result");
  }

  /** The planning timeout every route that waits on the planner should use. */
  get planningTimeoutMs(): number {
    return this.config.planningTimeoutMs;
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number = this.config.requestTimeoutMs,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(url, {
        ...init,
        signal: init.signal
          ? AbortSignal.any([controller.signal, init.signal])
          : controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async openGetStream(
    url: string,
    init: RequestInit,
    path: EnginePath,
  ): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.fetchWithTimeout(url, init);
        if (response.ok) {
          return response;
        }
        if (attempt === 0 && isRetryableStatus(response.status)) {
          await this.retryDelay(25);
          continue;
        }
        const problem = await engineProblemFromResponse(response, path);
        throw new EngineProblemError(problem);
      } catch (error) {
        if (error instanceof EngineProblemError) {
          throw error;
        }
        if (attempt === 0) {
          await this.retryDelay(25);
          continue;
        }
        throw error;
      }
    }
    throw new Error("Engine stream request exhausted without result");
  }
}

function requestHeaders(
  context: EngineCallerContext,
  authorization: { m2mAccessToken: string; actorToken: string },
  options: RequestOptions,
): Record<string, string> {
  return {
    Authorization: `Bearer ${authorization.m2mAccessToken}`,
    "X-Alter-Actor-Token": authorization.actorToken,
    traceparent: context.traceparent,
    Accept: "application/json, application/problem+json",
    ...(options.body === undefined
      ? {}
      : { "content-type": "application/json" }),
    ...(options.idempotencyKey
      ? { "Idempotency-Key": options.idempotencyKey }
      : {}),
    ...(options.ifMatch ? { "If-Match": options.ifMatch } : {}),
  };
}

async function responseBody<TResponse>(
  response: Response,
): Promise<EngineResponse<TResponse>> {
  const text = await response.text();
  const result: EngineResponse<TResponse> = {
    status: response.status,
    body: (text ? JSON.parse(text) : undefined) as TResponse,
  };
  setIfPresent(result, "etag", response.headers.get("etag"));
  setIfPresent(result, "location", response.headers.get("location"));
  setIfPresent(result, "requestId", response.headers.get("request_id"));
  setIfPresent(result, "traceId", response.headers.get("trace_id"));
  return result;
}

function setIfPresent<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | null,
): void {
  if (value !== null) {
    target[key] = value;
  }
}

function assertEnginePath(path: string): asserts path is EnginePath {
  if (!path.startsWith("/api/v1/") || path.includes("://")) {
    throw new Error("Engine path must stay under /api/v1/");
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException
      ? error.name === "AbortError"
      : error instanceof Error && error.name === "AbortError"
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<EngineSseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let id: string | undefined;
  let event: string | undefined;
  let data: string[] = [];

  const dispatch = (): EngineSseMessage | undefined => {
    if (data.length === 0) {
      id = undefined;
      event = undefined;
      return undefined;
    }
    const message: EngineSseMessage = {
      data: JSON.parse(data.join("\n")) as unknown,
    };
    if (id !== undefined) {
      message.id = id;
    }
    if (event !== undefined) {
      message.event = event;
    }
    id = undefined;
    event = undefined;
    data = [];
    return message;
  };

  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      if (chunk.done && buffer) {
        lines.push(buffer);
        buffer = "";
      }
      for (const line of lines) {
        if (line === "") {
          const message = dispatch();
          if (message) {
            yield message;
          }
        } else if (!line.startsWith(":")) {
          const separator = line.indexOf(":");
          const field = separator < 0 ? line : line.slice(0, separator);
          const value =
            separator < 0
              ? ""
              : line.slice(separator + 1).replace(/^ /, "");
          if (field === "id") {
            id = value;
          } else if (field === "event") {
            event = value;
          } else if (field === "data") {
            data.push(value);
          }
        }
      }
      if (chunk.done) {
        const message = dispatch();
        if (message) {
          yield message;
        }
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
