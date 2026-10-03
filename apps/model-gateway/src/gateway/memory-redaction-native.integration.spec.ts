import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { join, resolve } from "node:path";
import { CostClient, FailoverModelProvider, startModelgwGrpcTransport } from "@alterx/adapters";
import { createMockCacheProvider, createMockConfigProvider, createMockEmbeddingProvider,
  createMockModelProvider, createMockPIIRedactionProvider, createMockQueueProvider } from "@alterx/shared-clients";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { expect, it } from "vitest";
import { AppModule } from "../app.module";
import { OperationalConfigProvider } from "../operations/operational-config-provider";

it.runIf(Boolean(process.env["MEMORY_REDACTION_NATIVE_DIR"]))("serves authenticated memory redaction through the real gateway", async () => {
  const directory = process.env["MEMORY_REDACTION_NATIVE_DIR"]!;
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "memory-native", alg: "RS256", use: "sig" };
  let tokenRequests = 0;
  const issuer = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/jwks") return response.end(JSON.stringify({ keys: [jwk] }));
    if (request.url !== "/oauth/token" || request.method !== "POST") { response.statusCode = 404; return response.end("{}"); }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({ grant_type: "client_credentials", client_id: "memory-fixture", client_secret: "memory-fixture-secret", audience: "alter-engine" });
    tokenRequests++;
    const now = Math.floor(Date.now() / 1000);
    const input = [{ alg: "RS256", kid: "memory-native" }, { iss: "https://memory.test/", aud: "alter-engine", iat: now, exp: now + 300 }].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
    response.end(JSON.stringify({ access_token: `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`, expires_in: 300 }));
  });
  await new Promise<void>(done => issuer.listen(0, "127.0.0.1", done));
  const issuerAddress = issuer.address(); if (!issuerAddress || typeof issuerAddress === "string") throw Error("Missing issuer address");
  const issuerUrl = `http://127.0.0.1:${issuerAddress.port}`;
  process.env["AUTH0_DOMAIN"] = "memory.test"; process.env["API_AUDIENCE"] = "alter-engine"; process.env["AUTH0_JWKS_URL"] = `${issuerUrl}/jwks`;
  const calls: { tenantId: string; text: string }[] = [];
  const pii = createMockPIIRedactionProvider({ redact: async request => {
    calls.push(request);
    if (request.text.includes("redaction-unavailable")) throw Error("Fixture redaction unavailable");
    return { redactedText: request.text.replaceAll("person@example.invalid", "<EMAIL_ADDRESS>"), entities: [] };
  } });
  let app: NestFastifyApplication | undefined;
  try {
    const module = await Test.createTestingModule({ imports: [AppModule.register(
      new OperationalConfigProvider(createMockConfigProvider(), undefined, "/native/memory-policy"),
      new FailoverModelProvider(createMockModelProvider({ invoke: async () => { throw Error("Redaction must not invoke a model"); } }), {}),
      pii, createMockEmbeddingProvider(), createMockCacheProvider(), createMockQueueProvider(), "native-cost", "native-admin",
      new CostClient({ address: "127.0.0.1:1", protoPath: resolve("packages/contracts/proto/alter/cost/v1/cost.proto") }),
    )] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter()); await app.init();
    const port = await new Promise<number>((done, reject) => {
      const server = createTcpServer(); server.on("error", reject); server.listen(0, "127.0.0.1", () => {
        const address = server.address(); if (!address || typeof address === "string") return reject(Error("Missing gateway address"));
        server.close(error => error ? reject(error) : done(address.port));
      });
    });
    const address = `127.0.0.1:${port}`;
    await startModelgwGrpcTransport(app, { bindAddress: address, protoPath: resolve("packages/contracts/proto/alter/modelgw/v1/modelgw.proto") });
    writeFileSync(join(directory, "ready.json"), JSON.stringify({ address, tokenUrl: `${issuerUrl}/oauth/token` }), { mode: 0o600 });
    const deadline = Date.now() + 110000;
    while (!existsSync(join(directory, "stop"))) {
      if (Date.now() > deadline) throw Error("Memory proof did not finish");
      await new Promise(done => setTimeout(done, 25));
    }
    const expected = JSON.parse(readFileSync(join(directory, "expected.json"), "utf8")) as { minimumCalls: number; tokenRequests?: number };
    expect(calls.length).toBeGreaterThanOrEqual(expected.minimumCalls); expect(tokenRequests).toBe(expected.tokenRequests ?? 1);
    writeFileSync(join(directory, "observed.json"), JSON.stringify({ tokenRequests, calls }), { mode: 0o600 });
  } finally {
    await app?.close(); await new Promise<void>((done, reject) => issuer.close(error => error ? reject(error) : done()));
  }
}, 120000);
