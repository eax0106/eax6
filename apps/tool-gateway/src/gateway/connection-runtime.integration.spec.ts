import "reflect-metadata";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { createSign, generateKeyPairSync } from "node:crypto";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AwsSecretsManagerProvider, MockBrowserAutomationProvider, MockEmailProvider, PostgresToolDatabaseProvider,
  SsrfGuardedFetcher, TavilySearchProvider, ToolGatewayClient, startToolgwGrpcTransport } from "@alterx/adapters";
import { resolveToolGatewayCredential } from "@alterx/adapters/testing";
import { ConnectionRegistrySnapshotSchema, type ConnectionRegistrySnapshot, type ToolgwInvokeToolRequest } from "@alterx/contracts";
import { createMockAuditEventHandler, createMockCacheProvider, createMockConfigProvider, createMockQueueProvider } from "@alterx/shared-clients";
import { AppModule } from "../app.module";
import { TOOLGW_PROTO_PATH } from "./grpc.constants";
import { resolveConnectionCredential } from "./connection-credential-client";

// The engine parent starts real restricted PostgreSQL and passes its guarded HTTP address.
// AWS Secrets Manager and Tavily protocol edges stay local; their real adapters make HTTP calls.
describe.runIf(Boolean(process.env.CONNECTION_RUNTIME_ENGINE_URL)).sequential("native connection credential consumption", () => {
  const environment = { ...process.env };
  let record: ConnectionRegistrySnapshot, tenant: string;
  const run = process.env.CONNECTION_RUNTIME_RUN_ID!;
  const engineUrl = process.env.CONNECTION_RUNTIME_ENGINE_URL!, lookupToken = process.env.CONNECTION_RUNTIME_LOOKUP_TOKEN!;
  let app: NestFastifyApplication, client: ToolGatewayClient, grpcAddress: string;
  let authorization: string, secretMode = "connected", secretReads = 0, searches = 0, revision = 0;
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const edge = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/jwks") { response.end(JSON.stringify({ keys: [{ ...key.publicKey.export({ format: "jwk" }), kid: "runtime-key", alg: "RS256", use: "sig" }] })); return; }
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as Record<string, unknown>;
    if (request.url === "/search") {
      searches++; response.end(JSON.stringify({ results: [{ title: "Native result", url: "https://example.test/result", content: String(body.query), score: 1 }] })); return;
    }
    secretReads++;
    if (body.SecretId !== record.secret_ref || secretMode === "missing" || secretMode === "unreadable") {
      response.statusCode = 400;
      response.end(JSON.stringify({ __type: secretMode === "unreadable" ? "AccessDeniedException" : "ResourceNotFoundException", message: "Fixture credential unavailable" })); return;
    }
    let value = process.env.CONNECTION_RUNTIME_DATABASE_URL!;
    if (secretMode === "bad_auth") { const connection = new URL(value); connection.password = "wrong-fixture-password"; value = connection.href; }
    response.end(JSON.stringify({ SecretString: secretMode === "empty" ? "" : value }));
  });
  const input = (changes: Partial<ToolgwInvokeToolRequest> = {}): ToolgwInvokeToolRequest => ({ tenant_id: tenant, run_id: run,
    node_execution_id: "node_00000000-0000-7000-8000-000000000008", tool_name: "search.web", credential_ref: record.secret_ref,
    input_json: JSON.stringify({ query: `native lookup ${searches}` }), ...changes });
  const rpcConfig = () => ({ address: grpcAddress, protoPath: TOOLGW_PROTO_PATH, accessTokenProvider: { getAccessToken: async () => authorization } });
  const credential = (changes = {}) => resolveToolGatewayCredential(rpcConfig(), { tenant_id: tenant, run_id: run,
    integration_id: `itg_${record.connection_id}`, credential_ref: record.secret_ref, ...changes });
  async function status(value: "connected" | "revoked") {
    const response = await fetch(new URL("/internal/connections/upsert", engineUrl), { method: "POST",
      headers: { authorization: `Bearer ${process.env.CONNECTION_RUNTIME_WRITE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ...record, status: value, source_revision: ++revision }) });
    expect(response.status).toBe(200);
  }
  beforeAll(async () => {
    record = ConnectionRegistrySnapshotSchema.parse(JSON.parse(process.env.CONNECTION_RUNTIME_RECORD!));
    tenant = `ten_${record.tenant_id}`;
    revision = record.source_revision;
    await new Promise<void>(resolve => edge.listen(0, "127.0.0.1", resolve));
    const address = edge.address(); if (!address || typeof address === "string") throw new Error("Native HTTP edge has no port");
    const url = `http://127.0.0.1:${address.port}`;
    Object.assign(process.env, { AUTH0_DOMAIN: "runtime.test", API_AUDIENCE: "alter-engine", AUTH0_JWKS_URL: url + "/jwks",
      AWS_ENDPOINT_URL: url, AWS_ACCESS_KEY_ID: "fixture", AWS_SECRET_ACCESS_KEY: "fixture", AWS_EC2_METADATA_DISABLED: "true" });
    const now = Math.floor(Date.now() / 1000);
    const encoded = [ { alg: "RS256", kid: "runtime-key", typ: "JWT" }, { iss: "https://runtime.test/", aud: "alter-engine", iat: now, exp: now + 300 } ]
      .map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
    authorization = encoded + "." + createSign("RSA-SHA256").update(encoded).sign(key.privateKey).toString("base64url");
    const port = createNetServer(); await new Promise<void>(resolve => port.listen(0, "127.0.0.1", resolve));
    const portAddress = port.address(); if (!portAddress || typeof portAddress === "string") throw new Error("Native gRPC fixture has no port");
    grpcAddress = `127.0.0.1:${portAddress.port}`; await new Promise<void>(resolve => port.close(() => resolve()));
    const secrets = new AwsSecretsManagerProvider({ region: "ap-south-1" }), fetcher = new SsrfGuardedFetcher();
    app = await NestFactory.create<NestFastifyApplication>(AppModule.register(
      createMockConfigProvider({ resolveToolPermission: async () => ({ allowed: true, rateLimitPerMinute: 1000, requiredScopes: [`database:${record.connection_id}`] }) }),
      secrets, new TavilySearchProvider({ apiKey: "fixture", baseUrl: url }), fetcher, createMockAuditEventHandler(),
      new PostgresToolDatabaseProvider(secrets), createMockQueueProvider(), "native-runtime-cost", createMockCacheProvider(),
      new MockBrowserAutomationProvider(fetcher), new MockEmailProvider(),
      { resolveConnection: query => resolveConnectionCredential(engineUrl, lookupToken, query) }), new FastifyAdapter(), { logger: false });
    await app.init(); await startToolgwGrpcTransport(app, { bindAddress: grpcAddress, protoPath: TOOLGW_PROTO_PATH });
    client = new ToolGatewayClient(rpcConfig());
  }, 30_000);
  afterAll(async () => {
    await app?.close(); await new Promise<void>(resolve => edge.close(() => resolve()));
    for (const name of Object.keys(process.env)) if (!(name in environment)) delete process.env[name];
    Object.assign(process.env, environment);
  });
  it("dispatches raw and opaque references through current records, real providers and existing RPC authentication", async () => {
    const output = await client.invoke(input()); expect(JSON.parse(output.output_json).results[0].title).toBe("Native result");
    const resolved = await credential(); expect(resolved.resolved_reference).toMatch(/^cred_/);
    const reads = secretReads;
    await client.invoke(input({ credential_ref: resolved.resolved_reference })); expect(secretReads).toBeGreaterThan(reads);
    const database = await client.invoke(input({ credential_ref: resolved.resolved_reference, tool_name: "database.select",
      input_json: JSON.stringify({ databaseId: record.connection_id, statement: "SELECT $1::integer AS answer", parameters: [42] }) }));
    expect(JSON.parse(database.output_json)).toMatchObject({ rowCount: 1, rows: [{ answer: 42 }] });
    await expect(client.invoke(input({ run_id: process.env.CONNECTION_RUNTIME_OTHER_RUN_ID! }))).rejects.toMatchObject({ kind: "credential_missing", retryable: false });
    await expect(client.invoke(input({ run_id: process.env.CONNECTION_RUNTIME_OTHER_RUN_ID!, credential_ref: resolved.resolved_reference }))).rejects.toMatchObject({ kind: "credential_missing" });
    await expect(credential({ run_id: "" })).rejects.toMatchObject({ code: 9, details: "CREDENTIAL_MISSING" });
    await expect(credential({ integration_id: "itg_00000000-0000-7000-8000-000000000099" })).rejects.toMatchObject({ code: 9, details: "CREDENTIAL_MISSING" });
    const saved = authorization; authorization = "invalid";
    try { await expect(credential()).rejects.toMatchObject({ code: 16 }); }
    finally { authorization = saved; }
    await status("revoked");
    for (const reference of [record.secret_ref, resolved.resolved_reference]) await expect(client.invoke(input({ credential_ref: reference }))).rejects.toMatchObject({ kind: "credential_missing", retryable: false });
    await expect(credential()).rejects.toMatchObject({ code: 9, details: "CREDENTIAL_MISSING" });
    await status("connected");
  });
  it("reports missing, empty and unreadable credential material as the named gap through both RPC entry points", async () => {
    for (const mode of ["missing", "empty", "unreadable"]) {
      secretMode = mode; const before = searches;
      await expect(client.invoke(input())).rejects.toMatchObject({ kind: "credential_missing", code: "CREDENTIAL_MISSING", retryable: false });
      await expect(credential()).rejects.toMatchObject({ code: 9, details: "CREDENTIAL_MISSING" });
      expect(searches).toBe(before);
    }
    secretMode = "connected";
  });
  it("reports actual PostgreSQL credential refusal as the existing named runtime gap", async () => {
    const resolved = await credential(); secretMode = "bad_auth";
    try {
      for (const reference of [record.secret_ref, resolved.resolved_reference]) await expect(client.invoke(input({ credential_ref: reference, tool_name: "database.select",
        input_json: JSON.stringify({ databaseId: record.connection_id, statement: "SELECT $1::integer AS answer", parameters: [42] }) }))).rejects.toMatchObject({ kind: "credential_missing", code: "CREDENTIAL_MISSING", retryable: false });
    } finally { secretMode = "connected"; }
  });
});
