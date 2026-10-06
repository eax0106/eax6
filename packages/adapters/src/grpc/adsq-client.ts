import { credentials, loadPackageDefinition, Metadata, status, type Client } from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";

/** One retrieved chunk of a workspace document, with its text. */
export interface AdsRetrievalHit {
  readonly document_id: string;
  readonly chunk_reference: string;
  readonly score: number;
  readonly confidence: number;
  readonly provenance_json: string;
  readonly context: string;
}

export interface AdsRetrieveRequest {
  readonly tenant_id: string;
  readonly workspace_id: string;
  readonly query: string;
  readonly top_k: number;
  readonly requester: string;
}

export interface AdsQueryHandlerClient {
  retrieve(request: AdsRetrieveRequest): Promise<readonly AdsRetrievalHit[]>;
}

export interface AdsQueryClientConfig {
  readonly address: string;
  readonly protoPath: string;
  /** Sent verbatim; ADS Q requires the internal service credential. */
  readonly authorization: string;
  readonly timeoutMs?: number;
}

export class AdsQueryClientError extends Error {
  constructor(readonly code: "invalid_argument" | "permission_denied" | "deadline_exceeded" | "upstream", options?: ErrorOptions) {
    super(`ADS query failed: ${code}`, options);
  }
}

interface AdsqGrpcClient extends Client {
  Retrieve(
    request: AdsRetrieveRequest & { readonly scope_ids: readonly string[]; readonly metadata_filter_json: string },
    metadata: Metadata,
    options: { readonly deadline: Date },
    callback: (error: Error | null, response?: { readonly hits?: readonly AdsRetrievalHit[] }) => void,
  ): void;
}

/** ADS Q Retrieve over gRPC: the workspace's documents, ranked for a query. */
export class AdsQueryClient implements AdsQueryHandlerClient {
  readonly #client: AdsqGrpcClient;
  readonly #metadata = new Metadata();
  readonly #timeoutMs: number;

  constructor(config: AdsQueryClientConfig, client?: AdsqGrpcClient) {
    this.#timeoutMs = config.timeoutMs ?? 10_000;
    this.#metadata.set("authorization", config.authorization);
    this.#client = client ?? AdsQueryClient.#buildClient(config);
  }

  static #buildClient(config: AdsQueryClientConfig): AdsqGrpcClient {
    const definition = loadSync(config.protoPath, { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
    const proto = loadPackageDefinition(definition) as unknown as {
      alter: { adsq: { v1: { AdsqService: new (address: string, creds: ReturnType<typeof credentials.createInsecure>) => AdsqGrpcClient } } };
    };
    return new proto.alter.adsq.v1.AdsqService(config.address, credentials.createInsecure());
  }

  retrieve(request: AdsRetrieveRequest): Promise<readonly AdsRetrievalHit[]> {
    return new Promise((resolve, reject) => {
      this.#client.Retrieve({ ...request, scope_ids: [], metadata_filter_json: "{}" }, this.#metadata,
        { deadline: new Date(Date.now() + this.#timeoutMs) }, (error, response) => {
          if (error !== null) {
            const code = (error as Error & { code?: unknown }).code;
            reject(new AdsQueryClientError(
              code === status.INVALID_ARGUMENT ? "invalid_argument"
                : code === status.PERMISSION_DENIED ? "permission_denied"
                  : code === status.DEADLINE_EXCEEDED ? "deadline_exceeded" : "upstream",
              { cause: error },
            ));
            return;
          }
          resolve(response?.hits ?? []);
        });
    });
  }
}
