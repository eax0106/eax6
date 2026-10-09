// HTTP client for intelligence-service's SelectionBindingEngine (PLAN-7).
// That service is exposed as a FastAPI route (POST /selection-binding/
// bind-agent-model-tool), not gRPC -- see apps/intelligence-service/src/
// selection_binding/router.py. Mirrors PlannerClient's/PolicyStoreClient's
// injectable-fetch pattern rather than inventing a new HTTP-calling
// convention.

export interface SelectionBindingHttpClient {
  postJson(url: string, body: unknown): Promise<unknown>;
}

/**
 * Same fail-closed real-credential convention as PolicyStoreClient's
 * defaultServiceToken -- a missing INTERNAL_SERVICE_TOKEN must not degrade
 * into an anonymous request the callee then has to decide about.
 */
export function createFetchSelectionBindingHttpClient(
  readServiceToken: () => string = defaultServiceToken,
): SelectionBindingHttpClient {
  return {
    async postJson(url: string, body: unknown): Promise<unknown> {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${readServiceToken()}`,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const detail = await failureDetail(response);
        throw new Error(
          `Selection & Binding request to ${url} failed with status ${response.status}` +
            (detail ? `: ${detail}` : ""),
        );
      }
      return response.json();
    },
  };
}

const MAX_FAILURE_DETAIL_CHARS = 300;

/**
 * The service answers a failed bind with FastAPI's `{"detail": "..."}`, which
 * names the cause (for example invalid generated agent instructions versus a
 * bad embedding). Without it a failed run only shows the status code.
 */
async function failureDetail(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const detail =
      typeof body === "object" && body !== null && "detail" in body
        ? (body as { detail: unknown }).detail
        : undefined;
    const text = typeof detail === "string" ? detail : JSON.stringify(detail ?? "");
    return text.length > MAX_FAILURE_DETAIL_CHARS
      ? `${text.slice(0, MAX_FAILURE_DETAIL_CHARS)}...`
      : text;
  } catch {
    return "";
  }
}

export interface SelectionBindingClientConfig {
  readonly baseUrl: string;
}

export interface BindAgentModelToolRequest {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly node_key: string;
  readonly node_requirements_json: string;
  readonly workspace_id: string;
  readonly node_type: string;
  readonly task_category?: string;
}

export type BindAgentModelToolOutcome =
  | {
      readonly matched: true;
      readonly agent_id: string;
      readonly agent_version: number;
      readonly model_alias: string;
      readonly tool_names: readonly string[];
      /** The bound agent version's instructions; empty when it has none. */
      readonly instructions: string;
    }
  | { readonly matched: false; readonly reason: string };

export interface SelectionBindingHandler {
  bindAgentModelTool(
    request: BindAgentModelToolRequest,
  ): Promise<BindAgentModelToolOutcome>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class SelectionBindingResponseValidationError extends Error {
  constructor(reason: string) {
    super(`Selection & Binding bind response is invalid: ${reason}`);
    this.name = "SelectionBindingResponseValidationError";
  }
}

function parseBindResponse(raw: unknown): BindAgentModelToolOutcome {
  if (!isRecord(raw)) {
    throw new SelectionBindingResponseValidationError("response is not an object");
  }
  if (typeof raw.reason === "string") {
    return { matched: false, reason: raw.reason };
  }
  if (
    typeof raw.agent_id === "string" &&
    typeof raw.agent_version === "number" &&
    typeof raw.model_alias === "string" &&
    Array.isArray(raw.tool_names) &&
    raw.tool_names.every((name) => typeof name === "string")
  ) {
    return {
      matched: true,
      agent_id: raw.agent_id,
      agent_version: raw.agent_version,
      model_alias: raw.model_alias,
      tool_names: raw.tool_names,
      // Optional on the wire: an older intelligence-service does not send it.
      instructions: typeof raw.instructions === "string" ? raw.instructions : "",
    };
  }
  throw new SelectionBindingResponseValidationError(
    "neither a NoAgentMatch nor a BindAgentModelToolResponse shape",
  );
}

export class SelectionBindingClient implements SelectionBindingHandler {
  constructor(
    private readonly config: SelectionBindingClientConfig,
    private readonly httpClient: SelectionBindingHttpClient = createFetchSelectionBindingHttpClient(),
  ) {}

  async bindAgentModelTool(
    request: BindAgentModelToolRequest,
  ): Promise<BindAgentModelToolOutcome> {
    const raw = await this.httpClient.postJson(
      `${this.config.baseUrl}/selection-binding/bind-agent-model-tool`,
      request,
    );
    return parseBindResponse(raw);
  }
}

function defaultServiceToken(): string {
  const token = process.env["INTERNAL_SERVICE_TOKEN"]?.trim();
  if (!token) {
    throw new Error(
      "INTERNAL_SERVICE_TOKEN is required to call Selection & Binding",
    );
  }
  return token;
}
