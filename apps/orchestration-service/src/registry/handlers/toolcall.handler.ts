import { randomUUID } from "node:crypto";

import {
  AuditIdSchema,
  NodeExecutionIdSchema,
  ProblemDetailsSchema,
  RunIdSchema,
  TenantIdSchema,
  ToolCallCompiledConfigSchema,
  parseConnectionSecretReference,
  type NodeType,
  type ProblemDetails,
} from "@alterx/contracts";
import {
  ToolGatewayClientError,
  type ToolGatewayInvokeHandler,
} from "@alterx/adapters";

import type {
  NodeExecutionContext,
  NodeExecutionResult,
  NodeHandler,
} from "../handler";

interface ValidatedToolCall {
  readonly tenantId: string;
  readonly runId: string;
  readonly nodeExecutionId: string;
  readonly toolName: string;
  readonly inputJson: string;
  readonly credentialReference: string;
}

interface ValidationFailure {
  readonly detail: string;
  readonly field: string;
}

/** ToolCall routes every tool invocation through the Tool Gateway choke point. */
export class ToolCallHandler implements NodeHandler {
  readonly nodeType: NodeType = "ToolCall";

  constructor(private readonly toolGateway: ToolGatewayInvokeHandler) {}

  async execute(context: NodeExecutionContext): Promise<NodeExecutionResult> {
    const validated = validateExecution(context);
    if ("detail" in validated) {
      return problemResult(
        problem({
          context,
          type: "tool-call-validation",
          title: "Bad Request",
          status: 400,
          detail: validated.detail,
          errorCode: "TOOL_CALL_VALIDATION_FAILED",
          retryable: false,
          documentationKey: "execution.tool-call.validation-failed",
          fieldErrors: [{ field: validated.field, message: validated.detail }],
        }),
      );
    }

    let response: Awaited<ReturnType<ToolGatewayInvokeHandler["invoke"]>>;
    try {
      response = await this.toolGateway.invoke({
        tenant_id: validated.tenantId,
        run_id: validated.runId,
        node_execution_id: validated.nodeExecutionId,
        tool_name: validated.toolName,
        input_json: validated.inputJson,
        credential_ref: validated.credentialReference,
      });
    } catch (error: unknown) {
      return problemResult(problemForGatewayFailure(context, error));
    }

    let output: unknown;
    try {
      output = JSON.parse(response.output_json);
    } catch {
      return problemResult(invalidGatewayResponseProblem(context));
    }
    if (
      !isPlainObject(output) ||
      !AuditIdSchema.safeParse(response.audit_id).success
    ) {
      return problemResult(invalidGatewayResponseProblem(context));
    }

    return {
      output,
      metadata: { audit_id: response.audit_id },
    };
  }
}

function validateExecution(
  context: NodeExecutionContext,
): ValidatedToolCall | ValidationFailure {
  const tenant = TenantIdSchema.safeParse(context.tenant_id);
  if (!tenant.success) {
    return {
      field: "tenant_id",
      detail: "ToolCall requires tenant_id as a ten_ prefixed UUIDv7",
    };
  }
  const run = RunIdSchema.safeParse(context.run_id);
  if (!run.success) {
    return {
      field: "run_id",
      detail: "ToolCall requires run_id as a run_ prefixed UUIDv7",
    };
  }
  const nodeExecution = NodeExecutionIdSchema.safeParse(
    context.node_execution_id,
  );
  if (!nodeExecution.success) {
    return {
      field: "node_execution_id",
      detail:
        "ToolCall requires node_execution_id as a node_ prefixed UUIDv7",
    };
  }

  const config = ToolCallCompiledConfigSchema.safeParse(context.config);
  if (!config.success) {
    return {
      field: "config",
      detail: "ToolCall config does not match compiled ToolCall config",
    };
  }
  if (config.data.tool_name === undefined) {
    return {
      field: "config.tool_name",
      detail: "ToolCall requires non-empty config.tool_name",
    };
  }
  if (config.data.arguments === undefined) {
    return {
      field: "config.arguments",
      detail: "ToolCall requires config.arguments as an object",
    };
  }
  if (config.data.credential_ref === undefined) {
    return {
      field: "config.credential_ref",
      detail:
        "ToolCall requires canonical tenant integration config.credential_ref",
    };
  }
  const credentialTenant = credentialReferenceTenant(
    config.data.credential_ref,
  );
  if (credentialTenant !== tenant.data) {
    return {
      field: "config.credential_ref",
      detail: "ToolCall credential_ref is not owned by execution tenant",
    };
  }

  const resolved = resolveArgumentReferences(
    config.data.arguments,
    context.inputs,
    "config.arguments",
  );
  if (resolved instanceof ReferenceProblem) return resolved;

  let inputJson: string;
  try {
    const input =
      config.data.tool_name === "browser.click" && config.data.expected_page_state !== undefined
        ? isPlainObject(resolved)
          ? { ...resolved, expected_page_state: config.data.expected_page_state }
          : resolved
        : resolved;
    inputJson = JSON.stringify(
      input,
    );
  } catch {
    return {
      field: "config.arguments",
      detail: "ToolCall config.arguments must be JSON serializable",
    };
  }

  return {
    tenantId: tenant.data,
    runId: run.data,
    nodeExecutionId: nodeExecution.data,
    toolName: config.data.tool_name,
    inputJson,
    credentialReference: config.data.credential_ref,
  };
}

/** A class, so a failure can never be mistaken for a resolved upstream value. */
export class ReferenceProblem implements ValidationFailure {
  constructor(
    readonly field: string,
    readonly detail: string,
  ) {}
}

/**
 * Replaces every argument reference with the upstream output it names.
 *
 * A reference is an object of exactly {"$from": "<node key>"} or
 * {"$from": "<node key>", "path": "<field>.<field>"}: it stands for that
 * node's output, or the value at the dot-separated path inside it (a numeric
 * segment indexes an array). It is resolved against context.inputs, so it can
 * only name a node whose output reaches this one. A reference is a whole
 * value, never spliced into a string, so every argument is either written in
 * the plan or copied verbatim from one upstream output.
 */
export function resolveArgumentReferences(
  value: unknown,
  inputs: NodeExecutionContext["inputs"],
  field: string,
): unknown {
  if (Array.isArray(value)) {
    const resolved: unknown[] = [];
    for (const [index, item] of value.entries()) {
      const next = resolveArgumentReferences(item, inputs, `${field}.${index}`);
      if (next instanceof ReferenceProblem) return next;
      resolved.push(next);
    }
    return resolved;
  }
  if (!isPlainObject(value)) return value;
  if (Object.hasOwn(value, "$from")) return resolveReference(value, inputs, field);

  const resolved: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const next = resolveArgumentReferences(item, inputs, `${field}.${key}`);
    if (next instanceof ReferenceProblem) return next;
    resolved[key] = next;
  }
  return resolved;
}

function resolveReference(
  reference: Record<string, unknown>,
  inputs: NodeExecutionContext["inputs"],
  field: string,
): unknown {
  const { $from: from, path, ...rest } = reference;
  if (
    typeof from !== "string" ||
    from.length === 0 ||
    (path !== undefined && (typeof path !== "string" || path.length === 0)) ||
    Object.keys(rest).length > 0
  ) {
    return new ReferenceProblem(
      field,
      'ToolCall argument reference must be {"$from": "<node key>"} with an optional non-empty "path" string and no other fields',
    );
  }
  if (!Object.hasOwn(inputs, from)) {
    return new ReferenceProblem(
      field,
      `ToolCall argument references node "${from}", whose output is not an input of this node`,
    );
  }

  let current: unknown = inputs[from];
  for (const segment of path === undefined ? [] : path.split(".")) {
    if (Array.isArray(current)) {
      current = /^\d+$/.test(segment) ? current[Number(segment)] : undefined;
    } else {
      current =
        isPlainObject(current) && Object.hasOwn(current, segment)
          ? current[segment]
          : undefined;
    }
    if (current === undefined) {
      return new ReferenceProblem(
        field,
        `ToolCall argument references "${path}" in the output of node "${from}", which has no value there`,
      );
    }
  }
  return current;
}

function credentialReferenceTenant(reference: string): string | undefined {
  const connection = parseConnectionSecretReference(reference);
  if (connection) return `ten_${connection.tenant_id}`;
  return reference
    .split("/")
    .filter((segment) => segment.length > 0)[3];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function problemForGatewayFailure(
  context: NodeExecutionContext,
  error: unknown,
): ProblemDetails {
  if (!(error instanceof ToolGatewayClientError)) {
    return problem({
      context,
      type: "tool-gateway-internal",
      title: "Internal Server Error",
      status: 500,
      detail: "Tool invocation could not be completed",
      errorCode: "TOOL_GATEWAY_INTERNAL_ERROR",
      retryable: false,
      documentationKey: "execution.tool-call.internal-error",
    });
  }

  switch (error.kind) {
    case "credential_missing":
      return problem({
        context,
        type: "credential-missing",
        title: "Connection Required",
        status: 424,
        detail: "Required connection is unavailable. Reconnect the account before starting a new run.",
        errorCode: "CREDENTIAL_MISSING",
        retryable: false,
        documentationKey: "execution.tool-call.credential-missing",
      });
    case "invalid_argument":
      return problem({
        context,
        type: "tool-gateway-validation",
        title: "Bad Request",
        status: 400,
        detail: "Tool Gateway rejected invocation input",
        errorCode: "TOOL_GATEWAY_VALIDATION_FAILED",
        retryable: false,
        documentationKey: "execution.tool-call.gateway-validation",
      });
    case "permission_denied":
      return problem({
        context,
        type: "tool-gateway-permission-denied",
        title: "Forbidden",
        status: 403,
        detail: "Tool invocation is not permitted",
        errorCode: "TOOL_GATEWAY_PERMISSION_DENIED",
        retryable: false,
        documentationKey: "execution.tool-call.permission-denied",
      });
    case "rate_limited":
      return problem({
        context,
        type: "tool-gateway-rate-limited",
        title: "Too Many Requests",
        status: 429,
        detail: "Tool invocation rate limit exceeded",
        errorCode: "TOOL_GATEWAY_RATE_LIMITED",
        retryable: true,
        documentationKey: "execution.tool-call.rate-limited",
      });
    case "not_implemented":
      return problem({
        context,
        type: "tool-not-implemented",
        title: "Not Implemented",
        status: 501,
        detail: "Requested tool is not implemented",
        errorCode: "TOOL_NOT_IMPLEMENTED",
        retryable: false,
        documentationKey: "execution.tool-call.not-implemented",
      });
    case "deadline_exceeded":
    case "unavailable":
      return problem({
        context,
        type: "tool-gateway-unavailable",
        title: "Service Unavailable",
        status: 503,
        detail: "Tool Gateway is temporarily unavailable",
        errorCode: "TOOL_GATEWAY_UNAVAILABLE",
        retryable: true,
        documentationKey: "execution.tool-call.gateway-unavailable",
      });
    case "invalid_response":
      return invalidGatewayResponseProblem(context);
    case "internal":
      return problem({
        context,
        type: "tool-gateway-internal",
        title: "Bad Gateway",
        status: 502,
        detail: "Tool Gateway could not complete invocation",
        errorCode: "TOOL_GATEWAY_INTERNAL_ERROR",
        retryable: error.retryable,
        documentationKey: "execution.tool-call.gateway-error",
      });
  }
}

function invalidGatewayResponseProblem(
  context: NodeExecutionContext,
): ProblemDetails {
  return problem({
    context,
    type: "tool-gateway-invalid-response",
    title: "Bad Gateway",
    status: 502,
    detail: "Tool Gateway returned an invalid response",
    errorCode: "TOOL_GATEWAY_INVALID_RESPONSE",
    retryable: false,
    documentationKey: "execution.tool-call.invalid-response",
  });
}

function problem(input: {
  readonly context: NodeExecutionContext;
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly errorCode: string;
  readonly retryable: boolean;
  readonly documentationKey: string;
  readonly fieldErrors?: ProblemDetails["field_errors"];
}): ProblemDetails {
  const runId = RunIdSchema.safeParse(input.context.run_id);
  const nodeExecutionId = NodeExecutionIdSchema.safeParse(
    input.context.node_execution_id,
  );
  const instance =
    runId.success && nodeExecutionId.success
      ? `/runs/${runId.data}/node-executions/${nodeExecutionId.data}`
      : "/tool-call";
  return ProblemDetailsSchema.parse({
    type: `https://alter.dev/problems/${input.type}`,
    title: input.title,
    status: input.status,
    detail: input.detail,
    instance,
    error_code: input.errorCode,
    trace_id: prefixedUuidV7("trc"),
    request_id: prefixedUuidV7("req"),
    retryable: input.retryable,
    field_errors: input.fieldErrors ?? [],
    documentation_key: input.documentationKey,
  });
}

function problemResult(details: ProblemDetails): NodeExecutionResult {
  return {
    output: { ...details },
    metadata: {
      execution_status: "failed",
      problem_details: true,
    },
  };
}

function prefixedUuidV7(
  prefix: "trc" | "req",
): `${typeof prefix}_${string}` {
  const uuid = randomUUID();
  return `${prefix}_${uuid.slice(0, 14)}7${uuid.slice(15)}`;
}
