import { credentials, loadPackageDefinition, Metadata, status, type Client } from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";

export interface ProposeWritebackRequest {
  readonly tenant_id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly verified_output_artifact_id: string;
  readonly namespace: string;
}

export interface ProposeWritebackResponse {
  readonly memory_id: string;
  readonly candidate_json: string;
  readonly skipped?: boolean;
}

type WorkspaceRequest = Pick<ProposeWritebackRequest, "tenant_id" | "workspace_id">;
type SettingsResponse = { readonly settings_json: string };
type RecallResponse = { readonly memory_json: string };
type Unary<Request, Response> = (
  request: Request, metadata: Metadata, options: { readonly deadline: Date },
  callback: (error: Error | null, response?: Response) => void,
) => void;

export interface MemoryServiceClientConfig {
  readonly address: string;
  readonly protoPath: string;
  readonly authorization: string;
  readonly timeoutMs?: number;
}

export interface MemoryWritebackHandler {
  proposeWriteback(request: ProposeWritebackRequest): Promise<ProposeWritebackResponse>;
}

type MemoryServiceErrorCode = "invalid_argument" | "not_found" | "deadline_exceeded" | "precondition_required" | "conflict" | "upstream";

export class MemoryServiceClientError extends Error {
  constructor(readonly code: MemoryServiceErrorCode) {
    super("Memory Service request failed");
  }
}

interface MemoryGrpcClient extends Client {
  proposeWriteback: Unary<ProposeWritebackRequest, ProposeWritebackResponse>;
  getMemorySettings: Unary<WorkspaceRequest, SettingsResponse>;
  updateMemorySettings: Unary<WorkspaceRequest & { readonly actor_id: string; readonly settings_json: string; readonly if_match: string }, SettingsResponse>;
  memoryAccess: Unary<WorkspaceRequest & { readonly kind: "chat" | "workflow" | "workspace" }, { readonly allowed: boolean; readonly retention_days: number }>;
  recallChat: Unary<WorkspaceRequest & { readonly conversation_id: string; readonly messages_json: string }, RecallResponse>;
  recallWorkflow: Unary<WorkspaceRequest & { readonly workflow_id: string }, RecallResponse>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class MemoryServiceClient implements MemoryWritebackHandler {
  readonly #client: MemoryGrpcClient;
  readonly #timeoutMs: number;
  readonly #metadata: Metadata;

  constructor(config: MemoryServiceClientConfig, client?: MemoryGrpcClient) {
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#metadata = new Metadata();
    this.#metadata.set("authorization", config.authorization);
    this.#client = client ?? MemoryServiceClient.#buildClient(config);
  }

  static #buildClient(config: MemoryServiceClientConfig): MemoryGrpcClient {
    const packageDefinition = loadSync(config.protoPath, {
      keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
    });
    const proto = loadPackageDefinition(packageDefinition) as unknown as {
      alter: { memory: { v1: { MemoryService: new (
        address: string, creds: ReturnType<typeof credentials.createInsecure>,
      ) => MemoryGrpcClient } } };
    };
    return new proto.alter.memory.v1.MemoryService(config.address, credentials.createInsecure());
  }

  proposeWriteback(request: ProposeWritebackRequest): Promise<ProposeWritebackResponse> {
    return this.#unary(this.#client.proposeWriteback, request);
  }

  getMemorySettings(request: WorkspaceRequest): Promise<SettingsResponse> {
    return this.#unary(this.#client.getMemorySettings, request);
  }

  updateMemorySettings(request: Parameters<MemoryGrpcClient["updateMemorySettings"]>[0]): Promise<SettingsResponse> {
    return this.#unary(this.#client.updateMemorySettings, request);
  }

  memoryAccess(request: Parameters<MemoryGrpcClient["memoryAccess"]>[0]) {
    return this.#unary(this.#client.memoryAccess, request);
  }

  recallChat(request: Parameters<MemoryGrpcClient["recallChat"]>[0]): Promise<RecallResponse> {
    return this.#unary(this.#client.recallChat, request);
  }

  recallWorkflow(request: Parameters<MemoryGrpcClient["recallWorkflow"]>[0]): Promise<RecallResponse> {
    return this.#unary(this.#client.recallWorkflow, request);
  }

  close(): void { this.#client.close(); }

  #unary<Request, Response>(method: Unary<Request, Response>, request: Request): Promise<Response> {
    return new Promise((resolve, reject) => {
      method.call(
        this.#client,
        request,
        this.#metadata,
        { deadline: new Date(Date.now() + this.#timeoutMs) },
        (error, response) => {
          if (error !== null) {
            reject(new MemoryServiceClientError(errorCode(error)));
          } else if (response === undefined) {
            reject(new MemoryServiceClientError("upstream"));
          } else {
            resolve(response);
          }
        },
      );
    });
  }
}

function errorCode(error: Error): MemoryServiceErrorCode {
  const code = (error as Error & { code?: unknown }).code;
  if (code === status.INVALID_ARGUMENT) return "invalid_argument";
  if (code === status.NOT_FOUND) return "not_found";
  if (code === status.DEADLINE_EXCEEDED) return "deadline_exceeded";
  if (code === status.FAILED_PRECONDITION) return "precondition_required";
  if (code === status.ABORTED) return "conflict";
  return "upstream";
}
