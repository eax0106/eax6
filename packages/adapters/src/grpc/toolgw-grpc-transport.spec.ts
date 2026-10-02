import { createServer } from "node:net";
import { resolve } from "node:path";

import {
  credentials,
  loadPackageDefinition,
  type Client,
  type ServiceClientConstructor,
  type ServiceError,
} from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  ToolgwFetchUrlRequest,
  ToolgwFetchUrlResponse,
  ToolgwInvokeToolRequest,
  ToolgwInvokeToolResponse,
  ToolgwResolveCredentialRequest,
  ToolgwResolveCredentialResponse,
} from "@alterx/contracts";
import {
  TOOLGW_HANDLER,
  ToolGatewayCredentialMissingError,
  ToolGatewayPermissionError,
  ToolGatewayRateLimitError,
  ToolGatewayValidationError,
  ToolgwGrpcController,
  startToolgwGrpcTransport,
  type ToolgwHandler,
} from "./toolgw-grpc-transport";
import { SsrfBlockedError } from "../http/ssrf-guard";

interface ToolgwGrpcClient extends Client {
  invokeTool(
    request: ToolgwInvokeToolRequest,
    callback: (
      error: ServiceError | null,
      response: ToolgwInvokeToolResponse,
    ) => void,
  ): void;
  resolveCredential(
    request: ToolgwResolveCredentialRequest,
    callback: (
      error: ServiceError | null,
      response: ToolgwResolveCredentialResponse,
    ) => void,
  ): void;
  fetchUrl(
    request: ToolgwFetchUrlRequest,
    callback: (
      error: ServiceError | null,
      response: ToolgwFetchUrlResponse,
    ) => void,
  ): void;
}

interface ToolgwPackageDefinition {
  readonly alter: {
    readonly toolgw: {
      readonly v1: {
        readonly ToolgwService: ServiceClientConstructor;
      };
    };
  };
}

const protoPath = resolve(
  process.cwd(),
  "packages/contracts/proto/alter/toolgw/v1/toolgw.proto",
);

const handler: ToolgwHandler = {
  invokeTool: vi.fn(async (request: ToolgwInvokeToolRequest) => {
    if (request.tool_name === "credential-missing") throw new ToolGatewayCredentialMissingError();
    if (request.tool_name === "invalid") {
      throw new ToolGatewayValidationError("invalid tool request");
    }
    if (request.tool_name === "denied") {
      throw new ToolGatewayPermissionError("tool denied");
    }
    if (request.tool_name === "limited") {
      throw new ToolGatewayRateLimitError("tool limited");
    }
    if (request.tool_name === "explode") {
      throw new Error("internal secret value");
    }
    return {
      output_json: JSON.stringify({ ok: true }),
      audit_id: "aud_018f47a2-7b11-7b11-8a11-1234567890ab",
    };
  }),
  resolveCredential: vi.fn(async (request: ToolgwResolveCredentialRequest) => {
    if (request.credential_ref === "credential-missing") throw new ToolGatewayCredentialMissingError();
    if (request.credential_ref === "invalid") {
      throw new ToolGatewayValidationError("invalid credential request");
    }
    if (request.credential_ref === "explode") {
      throw new Error("raw secret material");
    }
    return {
      resolved_reference: "cred_opaque",
      expires_at: "2026-07-24T00:05:00.000Z",
    };
  }),
  fetchUrl: vi.fn(async (request: ToolgwFetchUrlRequest) => {
    if (request.url === "https://blocked.internal/") {
      throw new SsrfBlockedError("URL host is a blocked private/internal address");
    }
    return {
      status_code: 200,
      content_artifact_id: "art_018f47a2-7b11-7b11-8a11-1234567890ab",
    };
  }),
};

function invokeRequest(
  overrides: Partial<ToolgwInvokeToolRequest> = {},
): ToolgwInvokeToolRequest {
  return {
    tenant_id: "ten_018f47a2-7b11-7b11-8a11-1234567890ab",
    run_id: "run_018f47a2-7b11-7b11-8a11-1234567890ab",
    node_execution_id: "node_018f47a2-7b11-7b11-8a11-1234567890ab",
    tool_name: "search.web",
    input_json: "{}",
    credential_ref: "cred_opaque",
    ...overrides,
  };
}

function resolveRequest(
  overrides: Partial<ToolgwResolveCredentialRequest> = {},
): ToolgwResolveCredentialRequest {
  return {
    tenant_id: "ten_018f47a2-7b11-7b11-8a11-1234567890ab",
    integration_id: "itg_018f47a2-7b11-7b11-8a11-1234567890ab",
    credential_ref: "tenant/tool/credential",
    ...overrides,
  };
}

function fetchRequest(
  overrides: Partial<ToolgwFetchUrlRequest> = {},
): ToolgwFetchUrlRequest {
  return {
    tenant_id: "ten_018f47a2-7b11-7b11-8a11-1234567890ab",
    run_id: "run_018f47a2-7b11-7b11-8a11-1234567890ab",
    node_execution_id: "node_018f47a2-7b11-7b11-8a11-1234567890ab",
    url: "https://example.com",
    network_policy_json: "{}",
    ...overrides,
  };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePort);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not allocate local gRPC port");
  }
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) =>
      error === undefined ? resolveClose() : reject(error),
    );
  });
  return address.port;
}

function invokeTool(
  client: ToolgwGrpcClient,
  req: ToolgwInvokeToolRequest,
): Promise<ToolgwInvokeToolResponse> {
  return new Promise((resolveResponse, reject) => {
    client.invokeTool(req, (error, response) => {
      if (error === null) {
        resolveResponse(response);
      } else {
        reject(error);
      }
    });
  });
}

function resolveCredential(
  client: ToolgwGrpcClient,
  req: ToolgwResolveCredentialRequest,
): Promise<ToolgwResolveCredentialResponse> {
  return new Promise((resolveResponse, reject) => {
    client.resolveCredential(req, (error, response) => {
      if (error === null) {
        resolveResponse(response);
      } else {
        reject(error);
      }
    });
  });
}

function fetchUrl(
  client: ToolgwGrpcClient,
  req: ToolgwFetchUrlRequest,
): Promise<ToolgwFetchUrlResponse> {
  return new Promise((resolveResponse, reject) => {
    client.fetchUrl(req, (error, response) => {
      if (error === null) {
        resolveResponse(response);
      } else {
        reject(error);
      }
    });
  });
}

@Module({
  controllers: [ToolgwGrpcController],
  providers: [{ provide: TOOLGW_HANDLER, useValue: handler }],
})
class ToolgwGrpcTestModule {}

describe("toolgw gRPC transport adapter", () => {
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let client: ToolgwGrpcClient;

  beforeAll(async () => {
    app = await NestFactory.create(ToolgwGrpcTestModule, new FastifyAdapter(), {
      logger: false,
    });
    const port = await availablePort();
    await startToolgwGrpcTransport(app, {
      bindAddress: `127.0.0.1:${port}`,
      protoPath,
    });
    await app.init();

    const loaded = loadPackageDefinition(
      loadSync(protoPath, { keepCase: true }),
    ) as unknown as ToolgwPackageDefinition;
    client = new loaded.alter.toolgw.v1.ToolgwService(
      `127.0.0.1:${port}`,
      credentials.createInsecure(),
    ) as unknown as ToolgwGrpcClient;
  });

  afterAll(async () => {
    client.close();
    await app.close();
  });

  it("round-trips InvokeTool and ResolveCredential through generated types", async () => {
    await expect(invokeTool(client, invokeRequest())).resolves.toEqual({
      output_json: JSON.stringify({ ok: true }),
      audit_id: "aud_018f47a2-7b11-7b11-8a11-1234567890ab",
    });
    await expect(
      resolveCredential(client, resolveRequest()),
    ).resolves.toEqual({
      resolved_reference: "cred_opaque",
      expires_at: "2026-07-24T00:05:00.000Z",
    });
  });

  it("preserves the exact named credential gap through both real gRPC entry points", async () => {
    await expect(invokeTool(client, invokeRequest({ tool_name: "credential-missing" }))).rejects.toMatchObject({ code: 9, details: "CREDENTIAL_MISSING" });
    await expect(resolveCredential(client, resolveRequest({ credential_ref: "credential-missing", run_id: "run_018f47a2-7b11-7b11-8a11-1234567890ab" }))).rejects.toMatchObject({ code: 9, details: "CREDENTIAL_MISSING" });
  });

  it("maps validation, permission, and rate-limit failures to canonical gRPC statuses", async () => {
    await expect(
      invokeTool(client, invokeRequest({ tool_name: "invalid" })),
    ).rejects.toMatchObject({ code: 3 });
    await expect(
      invokeTool(client, invokeRequest({ tool_name: "denied" })),
    ).rejects.toMatchObject({ code: 7 });
    await expect(
      invokeTool(client, invokeRequest({ tool_name: "limited" })),
    ).rejects.toMatchObject({ code: 8 });
    await expect(
      resolveCredential(client, resolveRequest({ credential_ref: "invalid" })),
    ).rejects.toMatchObject({ code: 3 });
  });

  it("hides internal handler failures behind INTERNAL without leaking raw secret text", async () => {
    await expect(
      invokeTool(client, invokeRequest({ tool_name: "explode" })),
    ).rejects.toMatchObject({
      code: 13,
      details: "Tool invocation could not be completed",
    });
    await expect(
      resolveCredential(client, resolveRequest({ credential_ref: "explode" })),
    ).rejects.toMatchObject({
      code: 13,
      details: "Credential reference could not be resolved",
    });
  });

  it("forwards FetchUrl to the handler and returns its response", async () => {
    const response = await fetchUrl(client, fetchRequest());
    expect(response).toEqual({
      status_code: 200,
      content_artifact_id: "art_018f47a2-7b11-7b11-8a11-1234567890ab",
    });
  });

  it("maps a handler-rejected SSRF-blocked URL to PERMISSION_DENIED", async () => {
    await expect(
      fetchUrl(client, fetchRequest({ url: "https://blocked.internal/" })),
    ).rejects.toMatchObject({ code: 7 });
  });
});
