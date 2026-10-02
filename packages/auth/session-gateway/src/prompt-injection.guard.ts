import { randomUUID } from "node:crypto";
import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
} from "@nestjs/common";
import type { ProblemDetails } from "@alterx/contracts";
import { PromptInjectionClassifier } from "./prompt-injection-classifier";
import { PUBLIC_ROUTE_METADATA } from "./public-route";
import type { IdentityTenantGatewayRequest, IdentityTenantGatewayResponse } from "./types";

export interface SessionGatewayPromptInjectionOptions {
  readonly textFieldPath?: string;
}

const DEFAULT_TEXT_FIELD_PATH = "utterance";

interface PromptInjectionRequest extends IdentityTenantGatewayRequest {
  readonly body?: Readonly<Record<string, unknown>>;
}

function readField(
  body: Readonly<Record<string, unknown>> | undefined,
  path: string,
): string | undefined {
  const value = body?.[path];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

/**
 * Must run AFTER SessionGatewayGuard, same ordering requirement as
 * SessionGatewayRateLimitGuard -- it reads request.actorContext.tenant_id.
 *
 * This guard is a best-effort, defense-in-depth check on a single
 * configurable request-body field (default "utterance"). It intentionally
 * does not inspect every possible field or nested structure across every
 * future endpoint shape -- routes that don't carry a matching field are a
 * silent no-op, not a false sense of full coverage. Real per-endpoint
 * classification of chat/conversation payloads is the concern of whichever
 * endpoint actually owns that payload (e.g. Conversation Manager); this
 * guard only covers the case where the field is present at the HTTP layer.
 */
@Injectable()
export class SessionGatewayPromptInjectionGuard implements CanActivate {
  readonly #classifier: PromptInjectionClassifier;
  readonly #textFieldPath: string;

  constructor(
    classifier: PromptInjectionClassifier,
    options: SessionGatewayPromptInjectionOptions = {},
  ) {
    this.#classifier = classifier;
    this.#textFieldPath = options.textFieldPath ?? DEFAULT_TEXT_FIELD_PATH;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      Reflect.getMetadata(PUBLIC_ROUTE_METADATA, context.getHandler()) ===
        true ||
      Reflect.getMetadata(PUBLIC_ROUTE_METADATA, context.getClass()) === true
    ) {
      return true;
    }

    const http = context.switchToHttp();
    const request = http.getRequest<PromptInjectionRequest>();
    const text = readField(request.body, this.#textFieldPath);
    if (text === undefined) {
      return true;
    }

    const tenantId = request.actorContext?.tenant_id;
    if (tenantId === undefined) {
      return true;
    }

    const result = await this.#classifier.classify({
      tenantId,
      runId: `run_${randomUUID()}`,
      nodeExecutionId: `node_${randomUUID()}`,
      text,
    });

    if (!result.blocked) {
      return true;
    }

    const response = http.getResponse<IdentityTenantGatewayResponse>();
    setProblemContentType(response);
    throw new HttpException(
      promptInjectionProblem(request.url, result),
      400,
    );
  }
}

function setProblemContentType(response: IdentityTenantGatewayResponse): void {
  if (response.header) {
    response.header("content-type", "application/problem+json");
  } else {
    response.setHeader?.("content-type", "application/problem+json");
  }
}

function promptInjectionProblem(
  requestUrl: string | undefined,
  result: { readonly confidence: number; readonly reason?: string },
): ProblemDetails {
  const instance = requestUrl?.startsWith("/") ? requestUrl : "/";
  return {
    type: "https://alter.dev/problems/session-gateway-prompt-injection",
    title: "Bad Request",
    status: 400,
    detail:
      result.reason ??
      "The request content was classified as a prompt injection attempt.",
    instance,
    error_code: "SESSION_GATEWAY_PROMPT_INJECTION_DETECTED",
    trace_id: prefixedUuidV7("trc"),
    request_id: prefixedUuidV7("req"),
    retryable: false,
    field_errors: [],
    documentation_key: "auth.prompt-injection-detected",
  };
}

function prefixedUuidV7(prefix: "trc" | "req"): `${typeof prefix}_${string}` {
  const uuid = randomUUID();
  return `${prefix}_${uuid.slice(0, 14)}7${uuid.slice(15)}`;
}
