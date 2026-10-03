import { createSign, generateKeyPairSync } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { resolve } from "node:path";

import { ProblemDetailsSchema, applyNodeOverride } from "@alterx/contracts";
import { ToolGatewayClient } from "@alterx/adapters";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ToolCallHandler } from "./toolcall.handler";

const TENANT_ID = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const RUN_ID = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const NODE_EXECUTION_ID = "node_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const CREDENTIAL_REF = `/alter/prod/tenant/${TENANT_ID}/integration/search/access-token`;
const FIXTURE_SECRET_VALUE = "fixture-resolved-credential";
const FIXTURE_TAVILY_API_KEY = "fixture-tavily-api-key";
const PROTO_PATH = resolve(
  process.cwd(),
  "packages/contracts/proto/alter/toolgw/v1/toolgw.proto",
);
const SERVER_PATH = resolve(
  process.cwd(),
  "dist/apps/tool-gateway/testing/e2e-server.js",
);

interface TavilyRequest {
  readonly api_key?: unknown;
  readonly query?: unknown;
  readonly max_results?: unknown;
}

const tavilyRequests: TavilyRequest[] = [];
let tavilyServer: Server;
let toolGatewayProcess: ChildProcessWithoutNullStreams;
let handler: ToolCallHandler;
let address: string;

describe("ToolCallHandler real Tool Gateway boundary", () => {
  beforeAll(async () => {
    if (!existsSync(SERVER_PATH)) {
      throw new Error(
        "tool-gateway e2e server is not built; run this suite through nx",
      );
    }

    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = { ...pair.publicKey.export({ format: "jwk" }), kid: "toolcall-fixture", alg: "RS256", use: "sig" };
    const accessTokenProvider = { getAccessToken: async () => {
      const now = Math.floor(Date.now() / 1000);
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const input = `${encode({ alg: "RS256", kid: key.kid, typ: "JWT" })}.${encode({ iss: "https://toolcall-auth.test/", aud: "alter-engine", iat: now, exp: now + 300 })}`;
      return `${input}.${createSign("RSA-SHA256").update(input).sign(pair.privateKey).toString("base64url")}`;
    } };
    tavilyServer = createServer((request, response) => {
      if (request.url === "/.well-known/jwks.json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ keys: [key] }));
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        tavilyRequests.push(
          JSON.parse(Buffer.concat(chunks).toString("utf8")) as TavilyRequest,
        );
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            results: [
              {
                title: "AlterX result",
                url: "https://example.com/alterx",
                content: "Tool Gateway reached Tavily adapter",
                score: 0.99,
              },
            ],
          }),
        );
      });
    });
    const tavilyPort = await listenOnRandomPort(tavilyServer);
    const grpcPort = await availableTcpPort();
    address = `127.0.0.1:${grpcPort}`;

    toolGatewayProcess = spawn(process.execPath, [SERVER_PATH], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AUTH0_DOMAIN: "toolcall-auth.test",
        API_AUDIENCE: "alter-engine",
        AUTH0_JWKS_URL: `http://127.0.0.1:${tavilyPort}/.well-known/jwks.json`,
        TOOLGW_E2E_CREDENTIAL_REF: CREDENTIAL_REF,
        TOOLGW_E2E_GRPC_ADDRESS: `127.0.0.1:${grpcPort}`,
        TOOLGW_E2E_PROTO_PATH: PROTO_PATH,
        TOOLGW_E2E_SECRET_VALUE: FIXTURE_SECRET_VALUE,
        TOOLGW_E2E_TAVILY_API_KEY: FIXTURE_TAVILY_API_KEY,
        TOOLGW_E2E_TAVILY_BASE_URL: `http://127.0.0.1:${tavilyPort}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    await waitForReady(toolGatewayProcess);
    handler = new ToolCallHandler(
      new ToolGatewayClient({
        address,
        accessTokenProvider,
        protoPath: PROTO_PATH,
        timeoutMs: 5_000,
      }),
    );
  }, 30_000);

  afterAll(async () => {
    toolGatewayProcess?.kill("SIGTERM");
    await closeServer(tavilyServer);
  });

  it("refuses calls without service authentication before reaching the tool", async () => {
    const before = tavilyRequests.length;
    const unauthorized = new ToolCallHandler(new ToolGatewayClient({ address, protoPath: PROTO_PATH, timeoutMs: 5_000 }));
    const result = await unauthorized.execute(executionContext("search.web", { query: "must not be sent", maxResults: 2 }));
    expect(ProblemDetailsSchema.parse(result.output)).toMatchObject({ status: 502, error_code: "TOOL_GATEWAY_INTERNAL_ERROR" });
    expect(tavilyRequests).toHaveLength(before);
  });

  it("calls spawned Tool Gateway -> real search.web -> Tavily adapter", async () => {
    const result = await handler.execute(
      executionContext("search.web", { query: "AlterX", maxResults: 2 }),
    );

    expect(result.output).toEqual({
      results: [
        {
          title: "AlterX result",
          url: "https://example.com/alterx",
          snippet: "Tool Gateway reached Tavily adapter",
          score: 0.99,
        },
      ],
    });
    expect(result.metadata?.["audit_id"]).toMatch(
      /^aud_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(tavilyRequests).toContainEqual({
      api_key: FIXTURE_TAVILY_API_KEY,
      query: "AlterX",
      max_results: 2,
    });
    expect(JSON.stringify(result)).not.toContain(
      FIXTURE_SECRET_VALUE,
    );
    expect(JSON.stringify(result)).not.toContain(FIXTURE_TAVILY_API_KEY);
  });

  it("surfaces real Tool Gateway permission denial as RFC 9457", async () => {
    const result = await handler.execute(
      executionContext("search.denied", { query: "must not run" }),
    );
    const details = ProblemDetailsSchema.parse(result.output);

    expect(details).toMatchObject({
      status: 403,
      error_code: "TOOL_GATEWAY_PERMISSION_DENIED",
      retryable: false,
    });
    expect(details.trace_id).toMatch(/^trc_/);
    expect(details.request_id).toMatch(/^req_/);
  });

  it("routes a canonical manual tool change through authenticated Tool Gateway and retains credential validation", async () => {
    const initial = executionContext("email.send", { query: "Manual search", maxResults: 2 });
    const config = applyNodeOverride(initial.config, { kind: "tool", value: "search.web" });
    const result = await handler.execute({ ...initial, config });
    expect(config).toMatchObject({ tool_name: "search.web", manual_tool_override: true });
    expect(result.output).toMatchObject({ results: [expect.objectContaining({ title: "AlterX result" })] });
    expect(result.metadata?.["audit_id"]).toMatch(/^aud_/);
    expect(tavilyRequests).toContainEqual({ api_key: FIXTURE_TAVILY_API_KEY, query: "Manual search", max_results: 2 });
    const calls = tavilyRequests.length;
    const invalid = await handler.execute({ ...initial, config: { ...config, credential_ref: "unresolved" } });
    expect(ProblemDetailsSchema.parse(invalid.output)).toMatchObject({ status: 400, error_code: "TOOL_CALL_VALIDATION_FAILED" });
    expect(tavilyRequests).toHaveLength(calls);
  });
});

function executionContext(
  toolName: string,
  args: Record<string, unknown>,
) {
  return {
    config: {
      tool_name: toolName,
      arguments: args,
      credential_ref: CREDENTIAL_REF,
    },
    inputs: {},
    tenant_id: TENANT_ID,
    run_id: RUN_ID,
    node_execution_id: NODE_EXECUTION_ID,
  };
}

async function listenOnRandomPort(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Tavily fixture did not expose a TCP port");
  }
  return address.port;
}

async function availableTcpPort(): Promise<number> {
  const server = createTcpServer();
  const port = await new Promise<number>((resolvePort, rejectPort) => {
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        rejectPort(new Error("Could not reserve a Tool Gateway port"));
        return;
      }
      resolvePort(address.port);
    });
  });
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) =>
      error === undefined ? resolveClose() : rejectClose(error),
    );
  });
  return port;
}

async function waitForReady(
  processHandle: ChildProcessWithoutNullStreams,
): Promise<void> {
  await new Promise<void>((resolveReady, rejectReady) => {
    let stderr = "";
    const timeout = setTimeout(() => {
      rejectReady(
        new Error(`Tool Gateway readiness timed out: ${stderr.slice(-500)}`),
      );
    }, 15_000);
    processHandle.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    processHandle.once("exit", (code) => {
      clearTimeout(timeout);
      rejectReady(
        new Error(
          `Tool Gateway exited before ready (${String(code)}): ${stderr.slice(-500)}`,
        ),
      );
    });
    processHandle.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("TOOLGW_E2E_READY")) {
        clearTimeout(timeout);
        resolveReady();
      }
    });
  });
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (server === undefined) {
    return;
  }
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) =>
      error === undefined ? resolveClose() : rejectClose(error),
    );
  });
}
