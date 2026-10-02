import { status } from "@grpc/grpc-js";
import { describe, expect, it, vi } from "vitest";

import type {
  ToolgwInvokeToolRequest,
  ToolgwInvokeToolResponse,
} from "@alterx/contracts";
import {
  ToolGatewayClient,
  ToolGatewayClientError,
  type ToolGatewayClientErrorKind,
} from "./toolgw-client";

function fakeGrpcClient(
  handler: (
    request: ToolgwInvokeToolRequest,
  ) => {
    readonly error: (Error & { readonly code?: number }) | null;
    readonly response?: ToolgwInvokeToolResponse;
  },
) {
  return {
    invokeTool: vi.fn(
      (
        request: ToolgwInvokeToolRequest,
        _options: unknown,
        callback: (
          error: (Error & { readonly code?: number }) | null,
          response?: ToolgwInvokeToolResponse,
        ) => void,
      ) => {
        const { error, response } = handler(request);
        callback(error, response);
      },
    ),
  };
}

const REQUEST: ToolgwInvokeToolRequest = {
  tenant_id: "ten_018f47a2-7b11-7b11-8a11-1234567890ab",
  run_id: "run_018f47a2-7b11-7b11-8a11-1234567890ab",
  node_execution_id: "node_018f47a2-7b11-7b11-8a11-1234567890ab",
  tool_name: "search.web",
  input_json: JSON.stringify({ query: "AlterX" }),
  credential_ref:
    "/alter/prod/tenant/ten_018f47a2-7b11-7b11-8a11-1234567890ab/integration/search/access-token",
};

describe("ToolGatewayClient", () => {
  it("invokes the real Toolgw InvokeTool wire method with a deadline", async () => {
    const grpcClient = fakeGrpcClient(() => ({
      error: null,
      response: { output_json: JSON.stringify({ ok: true }), audit_id: "aud_1" },
    }));
    const client = new ToolGatewayClient(
      { address: "localhost:1234", protoPath: "unused" },
      grpcClient as never,
    );

    await expect(client.invoke(REQUEST)).resolves.toEqual({
      output_json: JSON.stringify({ ok: true }),
      audit_id: "aud_1",
    });
    expect(grpcClient.invokeTool).toHaveBeenCalledWith(
      REQUEST,
      expect.objectContaining({ deadline: expect.any(Date) }),
      expect.any(Function),
    );
  });

  it.each([
    [status.INVALID_ARGUMENT, "invalid_argument", false],
    [status.PERMISSION_DENIED, "permission_denied", false],
    [status.RESOURCE_EXHAUSTED, "rate_limited", true],
    [status.UNIMPLEMENTED, "not_implemented", false],
    [status.DEADLINE_EXCEEDED, "deadline_exceeded", true],
    [status.UNAVAILABLE, "unavailable", true],
    [status.UNKNOWN, "internal", false],
  ] as const)(
    "maps gRPC status %i to %s",
    async (code, kind, retryable) => {
      const error = Object.assign(new Error("provider detail"), { code });
      const client = new ToolGatewayClient(
        { address: "localhost:1234", protoPath: "unused" },
        fakeGrpcClient(() => ({ error })) as never,
      );

      const failure = await client.invoke(REQUEST).catch((caught: unknown) => caught);

      expect(failure).toBeInstanceOf(ToolGatewayClientError);
      expect((failure as ToolGatewayClientError).kind).toBe(
        kind satisfies ToolGatewayClientErrorKind,
      );
      expect((failure as ToolGatewayClientError).retryable).toBe(retryable);
      expect((failure as Error).message).not.toContain("provider detail");
    },
  );

  it("rejects an empty gRPC response as invalid_response", async () => {
    const client = new ToolGatewayClient(
      { address: "localhost:1234", protoPath: "unused" },
      fakeGrpcClient(() => ({ error: null })) as never,
    );

    await expect(client.invoke(REQUEST)).rejects.toMatchObject({
      name: "ToolGatewayClientError",
      kind: "invalid_response",
      retryable: false,
    });
  });

  it("propagates an acquired M2M token", async () => {
    const grpcClient = {
      invokeTool: vi.fn(
        (_request: unknown, metadata: { get(key: string): readonly string[] }, _options: unknown, callback: (error: null, response: ToolgwInvokeToolResponse) => void) => {
          expect(metadata.get("authorization")).toEqual(["Bearer signed-m2m-token"]);
          callback(null, { output_json: JSON.stringify({ ok: true }), audit_id: "aud_1" });
        },
      ),
    };
    const client = new ToolGatewayClient(
      {
        address: "localhost:1234",
        protoPath: "unused",
        accessTokenProvider: { getAccessToken: async () => "signed-m2m-token" },
      },
      grpcClient as never,
    );

    await expect(client.invoke(REQUEST)).resolves.toEqual({
      output_json: JSON.stringify({ ok: true }),
      audit_id: "aud_1",
    });
  });
});


it.each(["CREDENTIAL_MISSING", "unknown precondition", undefined])("maps only the named credential precondition: %s", async details => {
  const error = Object.assign(new Error("private provider detail"), { code: status.FAILED_PRECONDITION, details });
  const client = new ToolGatewayClient({ address: "localhost:1234", protoPath: "unused" }, fakeGrpcClient(() => ({ error })) as never);
  const failure = await client.invoke(REQUEST).catch((caught: unknown) => caught) as ToolGatewayClientError;
  expect(failure.kind).toBe(details === "CREDENTIAL_MISSING" ? "credential_missing" : "internal");
  expect(failure.code).toBe(details === "CREDENTIAL_MISSING" ? "CREDENTIAL_MISSING" : "TOOL_GATEWAY_INTERNAL_ERROR");
  expect(failure.retryable).toBe(false); expect(failure.message).not.toContain("private provider detail");
});
