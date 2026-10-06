import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PollyTtsProvider } from "@alterx/adapters";
import { createMockImageGenProvider, createMockObjectStorageProvider, createMockSpeechToTextProvider } from "@alterx/shared-clients";
import { RbacModule } from "../rbac";
import { PlatformDb } from "../signup/platform-db";
import { IdentityService } from "../identity/identity.service";
import { PgSessionStore } from "../identity/session-store";
import { createCreditPurchaseNativeDriver, type CreditPurchaseNativeDriver } from "../credit-purchases/testing/credit-purchase-native-driver";
import { MediaController } from "./media.controller";
import { MediaService } from "./media.service";

const database = process.env.DATABASE_URL;
describe.skipIf(!database).sequential("MVP media policy over native HTTP and current membership", () => {
  let d: CreditPurchaseNativeDriver, app: NestFastifyApplication, cookie: string;
  const workspace = uuidv7();
  const imageMock = createMockImageGenProvider(), sttMock = createMockSpeechToTextProvider();
  const imageCall = vi.fn(imageMock.generateImage.bind(imageMock)), sttCall = vi.fn(sttMock.transcribe.bind(sttMock));
  const image = { ...imageMock, generateImage: imageCall }, stt = { ...sttMock, transcribe: sttCall };
  const objectMock = createMockObjectStorageProvider();
  const put = vi.fn(objectMock.putObject.bind(objectMock));
  const objects = { ...objectMock, putObject: put };
  const send = vi.fn(async (command: unknown) => {
    expect(command).toHaveProperty("input");
    return { AudioStream: new Uint8Array(32_000).fill(0x11) };
  });
  const tts = new PollyTtsProvider({ region: "ap-south-1", bucketName: "media-test" }, objects,
    { send } as unknown as ConstructorParameters<typeof PollyTtsProvider>[2]);

  beforeAll(async () => {
    d = await createCreditPurchaseNativeDriver(database!);
    await d.admin.query("INSERT INTO workspaces(id,tenant_id,name,status) VALUES($1,$2,'Media','active')", [workspace, d.tenantA]);
    await d.admin.query("INSERT INTO workspace_members(id,tenant_id,workspace_id,user_id,role) VALUES($1,$2,$3,$4,'editor')", [uuidv7(), d.tenantA, workspace, d.userA]);
    const identity = new IdentityService({} as never, new PgSessionStore(d.pool));
    cookie = `alter_access=${(await identity.issueSignupSession(d.userA, d.tenantA)).accessToken}`;
    const module = await Test.createTestingModule({ imports: [RbacModule], controllers: [MediaController], providers: [
      { provide: MediaService, useValue: new MediaService(image, tts, stt, objects) },
    ] }).overrideProvider(IdentityService).useValue(identity).overrideProvider(PlatformDb).useValue(new PlatformDb(d.pool)).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init(); await app.getHttpAdapter().getInstance().ready();
  }, 60_000);
  afterAll(async () => { await app?.close(); await d?.close(); }, 60_000);
  beforeEach(() => { vi.clearAllMocks(); });
  const post = (action: string, payload: Record<string, unknown>, session = cookie) => app.inject({
    method: "POST", url: `/api/v1/media/${action}`, headers: { cookie: session }, payload,
  });

  it.each([
    ["image", { prompt: "a bicycle" }, "Image generation is not available in the MVP"],
    ["stt", { audio_ref: "s3://media-test/clip.wav" }, "Transcription is not available in the MVP"],
  ] as const)("refuses valid %s without touching providers", async (action, payload, detail) => {
    const response = await post(action, payload);
    expect(response.statusCode).toBe(503);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({ error_code: "MEDIA_ACTION_UNAVAILABLE", detail, retryable: false,
      instance: `/api/v1/media/${action}` });
    expect(imageCall).not.toHaveBeenCalled(); expect(sttCall).not.toHaveBeenCalled();
  });

  it("keeps request validation and refuses anonymous callers before any provider", async () => {
    for (const [action, payload] of [["image", { prompt: "a bicycle" }], ["stt", { audio_ref: "s3://media-test/clip.wav" }],
      ["tts", { text: "hello", voice_config: { voiceId: "Joanna" } }]] as const) {
      expect((await post(action, payload, "")).statusCode).toBe(403);
      const invalid = await post(action, {});
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error_code: "MEDIA_INPUT_INVALID" });
    }
    expect(imageCall).not.toHaveBeenCalled(); expect(sttCall).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });

  it("keeps speech enabled through the real service and Polly adapter, producing a WAV", async () => {
    const response = await post("tts", { text: "hello", voice_config: { voiceId: "Joanna" } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ mime_type: "audio/wav", duration_ms: 1_000 });
    expect(response.json().signed_url).toContain("download?reference=");
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]).toEqual([expect.objectContaining({ input: expect.objectContaining({ Text: "hello", VoiceId: "Joanna", OutputFormat: "pcm" }) })]);
    const [reference, bytes, mime] = put.mock.calls[0]!;
    expect(reference).toContain(`/tenants/${d.tenantA}/media/audio/`);
    expect(mime).toBe("audio/wav");
    const wav = Buffer.from(bytes as Uint8Array);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.byteLength).toBe(32_044);
  });

  it("uses current membership: a viewer cannot invoke speech or unavailable actions", async () => {
    await d.admin.query("UPDATE workspace_members SET role='viewer' WHERE workspace_id=$1", [workspace]);
    await d.admin.query("UPDATE tenant_members SET role='member' WHERE tenant_id=$1 AND user_id=$2", [d.tenantA, d.userA]);
    for (const action of ["image", "stt", "tts"]) expect((await post(action, {})).statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled(); expect(imageCall).not.toHaveBeenCalled(); expect(sttCall).not.toHaveBeenCalled();
  });
});
