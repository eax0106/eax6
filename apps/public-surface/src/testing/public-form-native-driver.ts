// Native engine proof controls only the external challenge/model/EventBridge edges.
import { PostgresOrchestrationStoreProvider, RedisPublicFormRateLimiter, RedisPublicFormReceiptStore, CloudflareTurnstileVerifier, EventBridgeEventPublisher } from "@alterx/adapters";
import { PublicFormTokenCodec, PromptInjectionClassifier } from "@alterx/auth";
import { PublicFormRepository } from "../public-form.repository";
import { PublicFormService } from "../public-form.service";
import { createPublicSurfaceServer } from "../server";

type Fixture = { database: string; redis: string; migrationsFolder: string; key: string; claims: Parameters<PublicFormTokenCodec["mint"]>[0] };
async function main(config: Fixture) {
  const store = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: config.database, migrationsFolder: config.migrationsFolder });
  const repository = new PublicFormRepository(store), codec = new PublicFormTokenCodec(config.key);
  const page = new RedisPublicFormRateLimiter(config.redis, "public-form:page", { form: 1000, visitor: 1000, windowSeconds: 60 });
  const submit = new RedisPublicFormRateLimiter(config.redis, "public-form:submit", { form: 1000, visitor: 1000, windowSeconds: 60 });
  const receipts = new RedisPublicFormReceiptStore(config.redis);
  const turnstile = new CloudflareTurnstileVerifier(async () => "fixture-only", "forms.example.test", async (_url, options) => Response.json({ success: true, hostname: "forms.example.test", action: "public_form", cdata: JSON.parse(String(options?.body)).response, challenge_ts: new Date().toISOString() }));
  const classifier = new PromptInjectionClassifier({ invoke: async () => ({ output_json: JSON.stringify({ injection_detected: false, confidence: 0.99, reason: "Controlled model edge" }), audit_id: "fixture" }) });
  const publisher = new EventBridgeEventPublisher({ region: "ap-south-1", busName: "fixture" }, { send: async command => {
    const entry = command.input.Entries![0]!;
    process.send?.({ event: { source: entry.Source, "detail-type": entry.DetailType, detail: JSON.parse(entry.Detail!) } });
    return { FailedEntryCount: 0 };
  } });
  const service = new PublicFormService(codec, repository, { page, submit }, turnstile, classifier, receipts, publisher, "native-visitor-hmac-key");
  const server = createPublicSurfaceServer(service, "fixture-site-key", "https://forms.example.test", async () => { await repository.verifyRuntimeRole(); await receipts.probe(); });
  await repository.verifyRuntimeRole(); await receipts.probe();
  await server.listen({ host: "127.0.0.1", port: 0 });
  process.send?.({ ready: `http://127.0.0.1:${(server.server.address() as { port: number }).port}`, token: codec.mint(config.claims) });
  process.on("disconnect", () => { void (async () => { await server.close(); await Promise.all([store.close(), page.close(), submit.close(), receipts.close()]); process.exit(0); })(); });
}
process.once("message", (config: Fixture) => { void main(config).catch(() => { process.send?.({ error: "Public form native driver failed" }); process.exit(1); }); });
