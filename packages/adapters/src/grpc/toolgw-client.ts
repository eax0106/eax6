import {
  credentials,
  loadPackageDefinition,
  status,
  type Client,
  type Metadata,
} from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";

import type {
  ToolgwInvokeToolRequest,
  ToolgwInvokeToolResponse,
} from "@alterx/contracts";
import {
  serviceAuthorizationMetadata,
  type ServiceAccessTokenProvider,
} from "./service-auth";

export interface ToolGatewayClientConfig {
  readonly address: string;
  readonly protoPath: string;
  readonly timeoutMs?: number;
  readonly accessTokenProvider?: ServiceAccessTokenProvider;
}

export interface ToolGatewayInvokeHandler {
  invoke(request: ToolgwInvokeToolRequest): Promise<ToolgwInvokeToolResponse>;
}

export type ToolGatewayClientErrorKind =
  | "credential_missing"
  | "invalid_argument"
  | "permission_denied"
  | "rate_limited"
  | "not_implemented"
  | "deadline_exceeded"
  | "unavailable"
  | "invalid_response"
  | "internal";

/**
 * `kind` spelled as a code FailureClassifier can score.
 *
 * NodeexecService writes an error's `code` to `node_executions.error.code`,
 * and the classifier matches that textually. These five spellings each land on
 * a pattern it already has -- PERMISSION_DENIED, RATE_LIMIT,
 * DEADLINE_EXCEEDED, UNAVAILABLE, INVALID_RESPONSE -- so a tool failure
 * selects the strategy for what actually went wrong rather than falling
 * through to ask_user (#149).
 *
 * `invalid_argument` and `not_implemented` are deliberately absent. Neither
 * describes a runtime condition recovery can act on -- both mean the call was
 * wrong before it was made -- and inventing a class for them would route a
 * caller bug into a retry loop.
 */
const TOOL_GATEWAY_ERROR_CODES: Partial<
  Readonly<Record<ToolGatewayClientErrorKind, string>>
> = {
  credential_missing: "CREDENTIAL_MISSING",
  permission_denied: "TOOL_GATEWAY_PERMISSION_DENIED",
  rate_limited: "TOOL_GATEWAY_RATE_LIMIT",
  deadline_exceeded: "TOOL_GATEWAY_DEADLINE_EXCEEDED",
  unavailable: "TOOL_GATEWAY_UNAVAILABLE",
  invalid_response: "TOOL_GATEWAY_INVALID_RESPONSE",
  internal: "TOOL_GATEWAY_INTERNAL_ERROR",
};

export class ToolGatewayClientError extends Error {
  readonly code: string;

  constructor(
    readonly kind: ToolGatewayClientErrorKind,
    readonly retryable: boolean,
    options: ErrorOptions = {},
  ) {
    super(`Tool Gateway request failed: ${kind}`, options);
    this.name = "ToolGatewayClientError";
    this.code = TOOL_GATEWAY_ERROR_CODES[kind] ?? `TOOL_GATEWAY_${kind.toUpperCase()}`;
  }
}

interface ToolgwGrpcClient extends Client {
  invokeTool(request: ToolgwInvokeToolRequest, options: { readonly deadline: Date }, callback: (error: (Error & { readonly code?: number }) | null, response?: ToolgwInvokeToolResponse) => void): void;
  invokeTool(
    request: ToolgwInvokeToolRequest,
    metadata: Metadata,
    options: { readonly deadline: Date },
    callback: (
      error: (Error & { readonly code?: number }) | null,
      response?: ToolgwInvokeToolResponse,
    ) => void,
  ): void;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Outbound Engine -> Tool Gateway gRPC client. Shape intentionally mirrors
 * ModelGatewayClient: insecure internal-channel credentials, proto-loader
 * keepCase, one per-call deadline, and no hidden retries.
 */
export class ToolGatewayClient implements ToolGatewayInvokeHandler {
  readonly #client: ToolgwGrpcClient;
  readonly #timeoutMs: number;
  readonly #accessTokenProvider: ServiceAccessTokenProvider | undefined;

  constructor(config: ToolGatewayClientConfig, client?: ToolgwGrpcClient) {
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#accessTokenProvider = config.accessTokenProvider;
    this.#client = client ?? ToolGatewayClient.#buildClient(config);
  }

  static #buildClient(config: ToolGatewayClientConfig): ToolgwGrpcClient {
    const packageDefinition = loadSync(config.protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const proto = loadPackageDefinition(packageDefinition) as unknown as {
      alter: {
        toolgw: {
          v1: {
            ToolgwService: new (
              address: string,
              creds: ReturnType<typeof credentials.createInsecure>,
            ) => ToolgwGrpcClient;
          };
        };
      };
    };
    return new proto.alter.toolgw.v1.ToolgwService(
      config.address,
      credentials.createInsecure(),
    );
  }

  async invoke(
    request: ToolgwInvokeToolRequest,
  ): Promise<ToolgwInvokeToolResponse> {
    return new Promise<ToolgwInvokeToolResponse>((resolve, reject) => {
      const deadline = new Date(Date.now() + this.#timeoutMs);
      const callback = (error: (Error & { readonly code?: number }) | null, response?: ToolgwInvokeToolResponse) => {
        if (error !== null) {
          reject(mapGrpcError(error));
          return;
        }
        if (response === undefined) {
          reject(
            new ToolGatewayClientError("invalid_response", false),
          );
          return;
        }
        resolve(response);
      };
      if (this.#accessTokenProvider === undefined) this.#client.invokeTool(request, { deadline }, callback);
      else void serviceAuthorizationMetadata(this.#accessTokenProvider).then((metadata) => this.#client.invokeTool(request, metadata, { deadline }, callback), reject);
    });
  }
}

function mapGrpcError(
  error: Error & { readonly code?: number },
): ToolGatewayClientError {
  switch (error.code) {
    case status.FAILED_PRECONDITION:
      return (error as Error & { readonly details?: unknown }).details === "CREDENTIAL_MISSING"
        ? new ToolGatewayClientError("credential_missing", false, { cause: error })
        : new ToolGatewayClientError("internal", false, { cause: error });
    case status.INVALID_ARGUMENT:
      return new ToolGatewayClientError("invalid_argument", false, {
        cause: error,
      });
    case status.PERMISSION_DENIED:
      return new ToolGatewayClientError("permission_denied", false, {
        cause: error,
      });
    case status.RESOURCE_EXHAUSTED:
      return new ToolGatewayClientError("rate_limited", true, {
        cause: error,
      });
    case status.UNIMPLEMENTED:
      return new ToolGatewayClientError("not_implemented", false, {
        cause: error,
      });
    case status.DEADLINE_EXCEEDED:
      return new ToolGatewayClientError("deadline_exceeded", true, {
        cause: error,
      });
    case status.UNAVAILABLE:
      return new ToolGatewayClientError("unavailable", true, {
        cause: error,
      });
    default:
      return new ToolGatewayClientError("internal", false, { cause: error });
  }
}
