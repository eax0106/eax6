import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { CloudflareTurnstileVerifier, EventBridgeEventPublisher, PostgresOrchestrationStoreProvider, RedisPublicFormRateLimiter, RedisPublicFormReceiptStore } from "@alterx/adapters";
import { PromptInjectionClassifier, PublicFormTokenCodec } from "@alterx/auth";
import { HostedFormDefinitionSchema, TriggerDispatchDetailSchema } from "@alterx/contracts";
import { PublicFormRepository } from "./public-form.repository";
import { PublicFormService } from "./public-form.service";
import { createPublicSurfaceServer } from "./server";

const tenant = "01970000-0000-7000-8000-000000000001", workspace = "01970000-0000-7000-8000-000000000002";
const trigger = "trg_01970000-0000-7000-8000-000000000003", version = "trv_01970000-0000-7000-8000-000000000004", workflow = "wf_01970000-0000-7000-8000-000000000005";
const claims = { tenantId: `ten_${tenant}`, triggerId: trigger, triggerVersionId: version };
const definition = HostedFormDefinitionSchema.parse({ title: '<script>alert("title")</script>', description: "<img src=x onerror=alert(1)>", fields: [{ name: "email", label: '<script>alert("label")</script>', type: "email", required: true }, { name: "note", label: "Message", type: "textarea", maxLength: 200 }] });
const migrationsFolder = resolve("apps/orchestration-service/drizzle"), codec = new PublicFormTokenCodec("37".repeat(32));
describe.sequential("ordinary PostgreSQL and native public form HTTP", () => {
  let postgres: StartedPostgreSqlContainer, redis: StartedTestContainer, admin: PostgresOrchestrationStoreProvider, store: PostgresOrchestrationStoreProvider;
  let repository: PublicFormRepository, receipts: RedisPublicFormReceiptStore, pageRate: RedisPublicFormRateLimiter, submitRate: RedisPublicFormRateLimiter;
  let server: ReturnType<typeof createPublicSurfaceServer>, url: string;
  let challengeAllowed = true, publishFails = false, classification: "benign" | "blocked" | "unavailable" | "malformed" = "benign";
  const delivered: unknown[] = [], modelInvoke = vi.fn(), challengeFetch = vi.fn();
  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:16-alpine").start();
    admin = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: postgres.getConnectionUri(), migrationsFolder });
    await admin.withTenant(tenant, async tx => { await tx.query("CREATE ROLE public_surface LOGIN PASSWORD 'public-fixture-only' NOBYPASSRLS NOSUPERUSER"); });
    await admin.migrate();
    await admin.withTenant(tenant, async tx => {
      await tx.query("INSERT INTO workflows(id,tenant_id,workspace_id,name) VALUES($1,$2,$3,'Inquiry')", [workflow, tenant, workspace]);
      await tx.query("INSERT INTO triggers(id,tenant_id,workspace_id,workflow_id,name,type,status,provider) VALUES($1,$2,$3,$4,'Inquiry','webhook','enabled','alter_public_form')", [trigger, tenant, workspace, workflow]);
      await tx.query("INSERT INTO trigger_versions(id,tenant_id,trigger_id,version,config,status) VALUES($1,$2,$3,1,$4,'active')", [version, tenant, trigger, JSON.stringify({ publicForm: definition, dlqPolicy: { maxReceiveCount: 5, visibilityTimeoutSeconds: 120 } })]);
    });
    const uri = new URL(postgres.getConnectionUri()); uri.username = "public_surface"; uri.password = "public-fixture-only";
    store = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: uri.href, migrationsFolder }); repository = new PublicFormRepository(store);
    redis = await new GenericContainer("redis:7-alpine").withExposedPorts(6379).start();
    const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    receipts = new RedisPublicFormReceiptStore(redisUrl);
    pageRate = new RedisPublicFormRateLimiter(redisUrl, "public-form:page", { form: 1000, visitor: 1000, windowSeconds: 60 });
    submitRate = new RedisPublicFormRateLimiter(redisUrl, "public-form:submit", { form: 1000, visitor: 1000, windowSeconds: 60 });
    challengeFetch.mockImplementation(async (_url: string, options: RequestInit) => {
      const input = JSON.parse(String(options.body));
      expect(input.secret).toBe("fixture-only");
      return Response.json({ success: challengeAllowed, hostname: "forms.example.com", action: "public_form", cdata: publicContext,
        challenge_ts: new Date().toISOString() });
    });
    modelInvoke.mockImplementation(async () => {
      if (classification === "unavailable") throw new Error("fixture model unavailable");
      return { output_json: classification === "malformed" ? "unparseable" : JSON.stringify({ injection_detected: classification === "blocked", confidence: .95, reason: "fixture classification edge" }) };
    });
    const publisher = new EventBridgeEventPublisher({ region: "ap-south-1", busName: "fixture" }, { send: async command => {
      if (publishFails) throw new Error("fixture event bridge unavailable");
      delivered.push(JSON.parse(command.input.Entries![0]!.Detail!)); return { FailedEntryCount: 0 };
    } });
    const service = new PublicFormService(codec, repository, { page: pageRate, submit: submitRate },
      new CloudflareTurnstileVerifier(async () => "fixture-only", "forms.example.com", challengeFetch),
      new PromptInjectionClassifier({ invoke: modelInvoke }), receipts, publisher, "fixture-visitor-hmac-key");
    publicContext = (await service.page(codec.mint(claims), "fixture-visitor")).context;
    server = createPublicSurfaceServer(service, "fixture-site-key", "https://forms.example.com", async () => { await repository.verifyRuntimeRole(); await receipts.probe(); });
    await server.listen({ host: "127.0.0.1", port: 0 }); url = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`;
  }, 120000);
  let publicContext = "";
  afterAll(async () => { await server?.close(); await Promise.all([pageRate?.close(), submitRate?.close(), receipts?.close(), store?.close(), admin?.close()]); await redis?.stop(); await postgres?.stop(); });
  const post = (body: unknown, token = codec.mint(claims), headers: Record<string, string> = {}) => fetch(`${url}/f/${token}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const valid = () => ({ submissionId: randomUUID(), turnstileResponse: "fixture-widget-token", values: { email: "lead@example.com", note: "Keep CASE exactly" } });
  it("serves escaped fields and headers, with no workflow/settings metadata or broad database grants", async () => {
    const response = await fetch(`${url}/f/${codec.mint(claims)}`), html = await response.text();
    expect(response.status).toBe(200); expect(html).toContain("&lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;"); expect(html).not.toContain('<script>alert("label")</script>');
    expect(html).not.toContain(workflow); expect(html).not.toContain(tenant); expect(html).not.toContain("dlqPolicy");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'"); expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store"); expect((await fetch(`${url}/health`)).status).toBe(200);
    await expect(repository.verifyRuntimeRole()).resolves.toBeUndefined();
    await expect(new PublicFormRepository(admin).verifyRuntimeRole()).rejects.toThrow("dedicated restricted");
    expect((await store.withTenant(tenant, tx => tx.query("SELECT config FROM trigger_versions"))).rows).toEqual([]);
    await expect(store.withTenant(tenant, tx => tx.query("SELECT * FROM workflows"))).rejects.toThrow("permission denied");
    await expect(store.withTenant(tenant, tx => tx.query("UPDATE triggers SET status='disabled'"))).rejects.toThrow("permission denied");
  });
  it("rejects accidental broad data and administrative grants before the public process can start", async () => {
    await admin.withTenant(tenant, tx => tx.query("GRANT SELECT ON events TO public_surface"));
    try { await expect(repository.verifyRuntimeRole()).rejects.toThrow("dedicated restricted"); }
    finally { await admin.withTenant(tenant, tx => tx.query("REVOKE SELECT ON events FROM public_surface")); }
    await admin.withTenant(tenant, tx => tx.query("GRANT SELECT(name) ON triggers TO public_surface"));
    try { await expect(repository.verifyRuntimeRole()).rejects.toThrow("dedicated restricted"); }
    finally { await admin.withTenant(tenant, tx => tx.query("REVOKE SELECT(name) ON triggers FROM public_surface")); }
    await admin.withTenant(tenant, tx => tx.query("ALTER ROLE public_surface CREATEROLE"));
    try { await expect(repository.verifyRuntimeRole()).rejects.toThrow("dedicated restricted"); }
    finally { await admin.withTenant(tenant, tx => tx.query("ALTER ROLE public_surface NOCREATEROLE")); }
    await expect(repository.verifyRuntimeRole()).resolves.toBeUndefined();
  });
  it("accepts through actual verifier/classifier/publisher adapters and preserves one submission across retries", async () => {
    const input = valid(), before = delivered.length;
    expect((await post(input)).status).toBe(202); expect((await post(input)).status).toBe(202);
    expect(delivered).toHaveLength(before + 1);
    const detail = TriggerDispatchDetailSchema.parse(delivered.at(-1));
    expect(detail).toMatchObject({ source: "alter.public-form", event_type: "public_form.submitted", tenant_id: claims.tenantId, workspace_id: `ws_${workspace}`, trigger_id: trigger, trigger_version: 1, payload: input.values });
    expect((await post({ ...input, values: { ...input.values, note: "Different input" } })).status).toBe(409);
    expect(modelInvoke.mock.calls.at(-1)![0]).toMatchObject({ tenant_id: claims.tenantId, model_alias: "FAST" });
  });
  it("enforces real HTTP visitor limits and trusts forwarded visitors only from its configured loopback edge", async () => {
    for (const trusted of [false, ["127.0.0.1", "::1"]] as const) {
      const page = new RedisPublicFormRateLimiter(`redis://${redis.getHost()}:${redis.getMappedPort(6379)}/${trusted === false ? 1 : 2}`, "public-form:page", { form: 10, visitor: 1, windowSeconds: 60 });
      const own = createPublicSurfaceServer(new PublicFormService(codec, repository, { page, submit: submitRate },
        new CloudflareTurnstileVerifier(async () => "fixture-only", "forms.example.com", challengeFetch),
        new PromptInjectionClassifier({ invoke: modelInvoke }), receipts,
        new EventBridgeEventPublisher({ region: "ap-south-1", busName: "fixture" }, { send: async () => ({ FailedEntryCount: 0 }) }), "fixture-visitor-hmac-key"),
        "fixture-site-key", "https://forms.example.com", async () => repository.verifyRuntimeRole(), trusted === false ? false : [...trusted]);
      try {
        await own.listen({ host: "127.0.0.1", port: 0 });
        const address = `http://127.0.0.1:${(own.server.address() as { port: number }).port}/f/${codec.mint(claims)}`;
        expect((await fetch(address, { headers: { "x-forwarded-for": "203.0.113.1" } })).status).toBe(200);
        expect((await fetch(address, { headers: { "x-forwarded-for": "203.0.113.2" } })).status).toBe(trusted === false ? 429 : 200);
        expect((await fetch(address, { headers: { "x-forwarded-for": "203.0.113.1" } })).status).toBe(429);
      } finally { await own.close(); await page.close(); }
    }
  });
  it("refuses fields, uploads, spoofed metadata, origin and body limits before model invocation", async () => {
    const before = modelInvoke.mock.calls.length;
    for (const values of [{ email: "bad" }, { email: "lead@example.com", uploads: [] }, { email: "lead@example.com", tenant_id: "forged" }, { email: "lead@example.com", note: "x".repeat(201) }]) expect((await post({ ...valid(), values })).status).toBe(400);
    expect((await post({ ...valid(), tenantId: claims.tenantId })).status).toBe(400);
    expect((await post(valid(), undefined, { origin: "https://different.example" })).status).toBe(403);
    expect((await post({ ...valid(), values: { note: "x".repeat(50000) } })).status).toBe(413);
    expect((await fetch(`${url}/f/${codec.mint(claims)}`, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=test" }, body: "test" })).status).toBe(415);
    expect(modelInvoke).toHaveBeenCalledTimes(before);
  });
  it("refuses rejected challenges and blocked/unavailable/malformed real classifier outcomes", async () => {
    const before = delivered.length;
    challengeAllowed = false; expect((await post(valid())).status).toBe(400); challengeAllowed = true;
    try {
      classification = "blocked"; expect((await post(valid())).status).toBe(400);
      classification = "unavailable"; expect((await post(valid())).status).toBe(503);
      classification = "malformed"; expect((await post(valid())).status).toBe(503);
      expect(delivered).toHaveLength(before);
    } finally { classification = "benign"; }
  });
  it("retries a verified pending publication without spending or reusing the challenge again", async () => {
    const input = valid(), challenges = challengeFetch.mock.calls.length, models = modelInvoke.mock.calls.length;
    publishFails = true; expect((await post(input)).status).toBe(503); publishFails = false;
    expect((await post(input)).status).toBe(202);
    expect(challengeFetch).toHaveBeenCalledTimes(challenges + 1); expect(modelInvoke).toHaveBeenCalledTimes(models + 1);
  });
  it("refuses unknown, foreign, disabled and superseded forms even for a previously accepted receipt", async () => {
    expect((await post(valid(), "unknown")).status).toBe(404);
    expect((await post(valid(), codec.mint({ ...claims, tenantId: "ten_01970000-0000-7000-8000-000000000009" }))).status).toBe(404);
    const input = valid(); expect((await post(input)).status).toBe(202);
    await admin.withTenant(tenant, tx => tx.query("UPDATE triggers SET status='disabled' WHERE id=$1", [trigger]));
    expect((await post(input)).status).toBe(404);
    await admin.withTenant(tenant, async tx => { await tx.query("UPDATE triggers SET status='enabled' WHERE id=$1", [trigger]); await tx.query("UPDATE trigger_versions SET status='superseded' WHERE id=$1", [version]); });
    expect((await post(input)).status).toBe(404);
    await admin.withTenant(tenant, tx => tx.query("UPDATE trigger_versions SET status='active' WHERE id=$1", [version]));
  });
});
