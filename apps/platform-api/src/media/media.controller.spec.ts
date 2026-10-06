import { describe, expect, it, vi } from "vitest";
import type { ActorContextType } from "../rbac";
import { MediaController } from "./media.controller";
import type { MediaService } from "./media.service";

const actor: ActorContextType = {
  user_id: "usr_018f47a5-7b2c-7d10-8f11-123456789abc",
  tenant_id: "ten_018f47a5-7b2c-7d10-8f11-123456789abc",
  workspace_id: "ws_018f47a5-7b2c-7d10-8f11-123456789abc",
  session_id: "session-a",
  auth_time: 1_700_000_000,
  roles: ["editor"],
  permissions: ["media:generate"],
};

function setup() {
  const service = {
    generateImage: vi.fn(async () => ({
      signed_url: "https://download.invalid/image",
      expires_at: "2026-01-01T00:00:00.000Z",
      mime_type: "image/png",
      width: 512,
      height: 512,
    })),
    synthesizeSpeech: vi.fn(async () => ({
      signed_url: "https://download.invalid/speech",
      expires_at: "2026-01-01T00:00:00.000Z",
      mime_type: "audio/wav",
      duration_ms: 500,
    })),
    transcribe: vi.fn(async () => ({ transcript: "hello", confidence: 0.9 })),
  } as unknown as MediaService;
  return { service, controller: new MediaController(service) };
}

describe("MediaController", () => {
  it("generateImage: refuses a valid request without invoking a provider", async () => {
    const { controller, service } = setup();
    await expect(controller.generateImage({ prompt: "a red bicycle", options: { width: 512 } }, actor)).rejects.toMatchObject({ status: 503 });
    expect(service.generateImage).not.toHaveBeenCalled();
  });

  it("generateImage: rejects an unauthenticated call before touching the service", async () => {
    const { controller, service } = setup();
    await expect(controller.generateImage({ prompt: "x", options: {} }, undefined)).rejects.toMatchObject({
      status: 401,
    });
    expect(service.generateImage).not.toHaveBeenCalled();
  });

  it("generateImage: rejects an invalid body before touching the service", async () => {
    const { controller, service } = setup();
    await expect(controller.generateImage({ prompt: "" }, actor)).rejects.toMatchObject({ status: 400 });
    expect(service.generateImage).not.toHaveBeenCalled();
  });

  it("synthesizeSpeech: maps voice_config to voiceConfig and delegates to the service", async () => {
    const { controller, service } = setup();
    const result = await controller.synthesizeSpeech(
      { text: "hello there", voice_config: { voiceId: "Joanna" } },
      actor,
    );

    expect(service.synthesizeSpeech).toHaveBeenCalledWith(
      actor.tenant_id,
      { text: "hello there", voiceConfig: { voiceId: "Joanna" } },
      "/api/v1/media/tts",
    );
    expect(result).toMatchObject({ mime_type: "audio/wav", duration_ms: 500 });
  });

  it("transcribe: refuses a valid request without invoking a provider", async () => {
    const { controller, service } = setup();
    await expect(controller.transcribe({ audio_ref: "s3://bucket/clip.wav" }, actor)).rejects.toMatchObject({ status: 503 });
    expect(service.transcribe).not.toHaveBeenCalled();
  });

  it("transcribe: rejects a body with no audio_ref before touching the service", async () => {
    const { controller, service } = setup();
    await expect(controller.transcribe({}, actor)).rejects.toMatchObject({ status: 400 });
    expect(service.transcribe).not.toHaveBeenCalled();
  });
});
