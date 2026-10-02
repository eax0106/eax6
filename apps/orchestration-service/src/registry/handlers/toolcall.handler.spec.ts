import {
  ProblemDetailsSchema,
  type ToolgwInvokeToolRequest,
  type ToolgwInvokeToolResponse,
} from "@alterx/contracts";
import {
  ToolGatewayClientError,
  type ToolGatewayInvokeHandler,
} from "@alterx/adapters";
import { describe, expect, it, vi } from "vitest";

import { classifyNodeFailure } from "../../recovery/failure-classifier";
import { ToolCallHandler } from "./toolcall.handler";

const TENANT_ID = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const OTHER_TENANT_ID = "ten_018f4d6e-2b4a-7a3e-8c1a-abcdefabcdef";
const RUN_ID = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const NODE_EXECUTION_ID = "node_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const CREDENTIAL_REF = `/alter/prod/tenant/${TENANT_ID}/integration/search/access-token`;

function gateway(
  invoke: (
    request: ToolgwInvokeToolRequest,
  ) => Promise<ToolgwInvokeToolResponse>,
): ToolGatewayInvokeHandler {
  return { invoke };
}

function context(
  config: Record<string, unknown> = {
    tool_name: "search.web",
    arguments: { query: "AlterX" },
    credential_ref: CREDENTIAL_REF,
  },
) {
  return {
    config,
    inputs: {},
    tenant_id: TENANT_ID,
    run_id: RUN_ID,
    node_execution_id: NODE_EXECUTION_ID,
  };
}

describe("ToolCallHandler", () => {
  it("invokes Tool Gateway with exact snake_case wire fields", async () => {
    const invoke = vi.fn().mockResolvedValue({
      output_json: JSON.stringify({ results: [{ title: "AlterX" }] }),
      audit_id: "aud_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
    });
    const handler = new ToolCallHandler(gateway(invoke));

    const result = await handler.execute(context());

    expect(invoke).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      node_execution_id: NODE_EXECUTION_ID,
      tool_name: "search.web",
      input_json: JSON.stringify({ query: "AlterX" }),
      credential_ref: CREDENTIAL_REF,
    });
    expect(result).toEqual({
      output: { results: [{ title: "AlterX" }] },
      metadata: {
        audit_id: "aud_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
      },
    });
  });

  it.each([
    [{ tool_name: "search.web", arguments: {} }, "config.credential_ref"],
    [
      {
        tool_name: "search.web",
        arguments: {},
        credential_ref: "literal-secret-value",
      },
      "config",
    ],
  ] as const)(
    "fails closed for missing or malformed credential_ref",
    async (configValue, expectedField) => {
      const invoke = vi.fn();
      const handler = new ToolCallHandler(gateway(invoke));

      const result = await handler.execute(context(configValue));

      expect(invoke).not.toHaveBeenCalled();
      const details = ProblemDetailsSchema.parse(result.output);
      expect(details.status).toBe(400);
      expect(details.error_code).toBe("TOOL_CALL_VALIDATION_FAILED");
      expect(details.field_errors[0]?.field).toBe(expectedField);
    },
  );

  it("rejects a canonical reference owned by another tenant", async () => {
    const invoke = vi.fn();
    const handler = new ToolCallHandler(gateway(invoke));
    const result = await handler.execute(
      context({
        tool_name: "search.web",
        arguments: {},
        credential_ref: `/alter/prod/tenant/${OTHER_TENANT_ID}/integration/search/access-token`,
      }),
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(result.output).toMatchObject({
      status: 400,
      error_code: "TOOL_CALL_VALIDATION_FAILED",
    });
  });

  it("rejects bare tenant UUID instead of stripping or reshaping it", async () => {
    const invoke = vi.fn();
    const handler = new ToolCallHandler(gateway(invoke));

    const result = await handler.execute({
      ...context(),
      tenant_id: TENANT_ID.slice("ten_".length),
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(result.output).toMatchObject({
      status: 400,
      error_code: "TOOL_CALL_VALIDATION_FAILED",
    });
  });

  it("maps permission denial to RFC 9457 with real trace/request IDs", async () => {
    const cause = new Error("resolved-secret-must-never-leak");
    const handler = new ToolCallHandler(
      gateway(async () => {
        throw new ToolGatewayClientError("permission_denied", false, {
          cause,
        });
      }),
    );

    const result = await handler.execute(context());
    const details = ProblemDetailsSchema.parse(result.output);

    expect(details).toMatchObject({
      status: 403,
      error_code: "TOOL_GATEWAY_PERMISSION_DENIED",
      retryable: false,
    });
    expect(details.trace_id).toMatch(/^trc_/);
    expect(details.request_id).toMatch(/^req_/);
    expect(JSON.stringify(result)).not.toContain("resolved-secret-must-never-leak");
  });

  it("fails closed on malformed Tool Gateway output", async () => {
    const handler = new ToolCallHandler(
      gateway(async () => ({
        output_json: JSON.stringify({ unsafe: true }),
        audit_id: "aud_not-a-uuidv7",
      })),
    );

    const result = await handler.execute(context());

    expect(result.output).toMatchObject({
      status: 502,
      error_code: "TOOL_GATEWAY_INVALID_RESPONSE",
    });
  });

  describe("argument references", () => {
    const EMAIL_REF = `/alter/prod/tenant/${TENANT_ID}/integration/email/access-token`;
    const inputs = {
      draft: { subject: "Weekly report", body: "All green.", tags: ["a", "b"] },
      open: { sessionId: "bb_123", expiresAt: "2099-01-01T00:00:00.000Z" },
    };

    function referencing(
      toolArguments: Record<string, unknown>,
    ): Parameters<ToolCallHandler["execute"]>[0] {
      return {
        ...context({ tool_name: "email.send", arguments: toolArguments, credential_ref: EMAIL_REF }),
        inputs,
      };
    }

    function okGateway() {
      return vi.fn().mockResolvedValue({
        output_json: "{}",
        audit_id: "aud_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
      });
    }

    it("replaces each reference with the upstream value it names", async () => {
      const invoke = okGateway();
      const handler = new ToolCallHandler(gateway(invoke));

      const result = await handler.execute(
        referencing({
          to: "ops@example.com",
          subject: { $from: "draft", path: "subject" },
          body: { $from: "draft", path: "body" },
          first_tag: { $from: "draft", path: "tags.1" },
          nested: [{ session: { $from: "open", path: "sessionId" } }],
          whole: { $from: "open" },
        }),
      );

      expect(result.metadata).toEqual({ audit_id: "aud_018f4d6e-2b4a-7a3e-8c1a-1234567890ab" });
      expect(JSON.parse(invoke.mock.calls[0]![0].input_json)).toEqual({
        to: "ops@example.com",
        subject: "Weekly report",
        body: "All green.",
        first_tag: "b",
        nested: [{ session: "bb_123" }],
        whole: inputs.open,
      });
    });

    it.each([
      [
        "a node that is not an input",
        { subject: { $from: "research", path: "subject" } },
        "config.arguments.subject",
        'node "research", whose output is not an input',
      ],
      [
        "a path with no value",
        { body: { $from: "draft", path: "content.text" } },
        "config.arguments.body",
        '"content.text" in the output of node "draft", which has no value there',
      ],
      [
        "an array index out of range",
        { tags: [{ $from: "draft", path: "tags.5" }] },
        "config.arguments.tags.0",
        "which has no value there",
      ],
      [
        "a reference with extra fields",
        { body: { $from: "draft", path: "body", fallback: "hi" } },
        "config.arguments.body",
        "no other fields",
      ],
      [
        "a reference whose $from is not a string",
        { body: { $from: 3 } },
        "config.arguments.body",
        "no other fields",
      ],
    ])("fails the node on %s, before calling the gateway", async (_name, toolArguments, field, detail) => {
      const invoke = okGateway();
      const handler = new ToolCallHandler(gateway(invoke));

      const result = await handler.execute(referencing(toolArguments));

      expect(invoke).not.toHaveBeenCalled();
      const details = ProblemDetailsSchema.parse(result.output);
      expect(details.error_code).toBe("TOOL_CALL_VALIDATION_FAILED");
      expect(details.field_errors).toEqual([{ field, message: expect.stringContaining(detail) }]);
      expect(result.metadata).toMatchObject({ execution_status: "failed" });
    });

    it("does not resolve a reference-shaped value that arrives from upstream", async () => {
      const invoke = okGateway();
      const handler = new ToolCallHandler(gateway(invoke));

      await handler.execute({
        ...referencing({ to: "ops@example.com", body: { $from: "draft", path: "body" } }),
        inputs: { draft: { body: { $from: "open", path: "sessionId" } }, open: inputs.open },
      });

      expect(JSON.parse(invoke.mock.calls[0]![0].input_json).body).toEqual({ $from: "open", path: "sessionId" });
    });
  });
});


it("keeps a named credential gap through the handler and recovery classifier", async () => {
  const handler = new ToolCallHandler(gateway(async () => { throw new ToolGatewayClientError("credential_missing", false); }));
  const result = await handler.execute(context());
  const details = ProblemDetailsSchema.parse(result.output);
  expect(details).toMatchObject({ status: 424, error_code: "CREDENTIAL_MISSING", retryable: false });
  expect(result.metadata).toMatchObject({ execution_status: "failed" });
  expect(classifyNodeFailure({ nodeType: "ToolCall", attempt: 1, error: { code: details.error_code, detail: details.detail } }, { trace_id: details.trace_id, request_id: details.request_id }).failureClass).toBe("credential_missing");
});
