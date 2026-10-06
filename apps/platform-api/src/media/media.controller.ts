import { Body, Controller, Post, UseFilters } from "@nestjs/common";
import { ActorContext, RequirePermission, RequireWorkspaceRole, type ActorContextType } from "../rbac";
import { MediaExceptionFilter } from "./media-exception.filter";
import { MediaHttpError } from "./problem";
import { MediaService } from "./media.service";
import { parseGenerateImageInput, parseSynthesizeSpeechInput, parseTranscribeInput } from "./validation";
import type { GeneratedImageResult, SynthesizedSpeechResult, TranscriptionResult } from "./types";

const mediaRoles = ["admin", "editor", "operator"] as const;

// media:generate is a new permission, not a reuse of an existing one --
// unlike EventController's reuse of runs:read, nothing existing fits
// here: this isn't reading runs/knowledge/projects, it's invoking a
// real, paid, standalone media-generation call. Granted (rbac/
// permissions.ts) to the same role set as projects:write/workflows:write:
// the roles that build and test workflow configurations, not read-only
// roles.
@Controller("/api/v1/media")
@UseFilters(MediaExceptionFilter)
@RequireWorkspaceRole(...mediaRoles)
@RequirePermission("media:generate")
export class MediaController {
  constructor(private readonly media: MediaService) {}

  // /media/image, /media/tts, /media/stt -- never a vendor name in a
  // route path (ENG-MEDIA.md's own audit checklist item), and response
  // bodies (see ./types.ts) never carry a provider field a client would
  // branch on.

  @Post("image")
  async generateImage(
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
  ): Promise<GeneratedImageResult> {
    const instance = "/api/v1/media/image";
    requireActor(actor, instance);
    parseGenerateImageInput(body, instance);
    throw new MediaHttpError(503, "MEDIA_ACTION_UNAVAILABLE", "Image generation is not available in the MVP", instance);
  }

  @Post("tts")
  async synthesizeSpeech(
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
  ): Promise<SynthesizedSpeechResult> {
    const instance = "/api/v1/media/tts";
    const tenantId = requireActor(actor, instance).tenant_id;
    return this.media.synthesizeSpeech(
      tenantId,
      parseSynthesizeSpeechInput(body, instance),
      instance,
    );
  }

  @Post("stt")
  async transcribe(
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
  ): Promise<TranscriptionResult> {
    const instance = "/api/v1/media/stt";
    requireActor(actor, instance);
    parseTranscribeInput(body, instance);
    throw new MediaHttpError(503, "MEDIA_ACTION_UNAVAILABLE", "Transcription is not available in the MVP", instance);
  }
}

function requireActor(actor: ActorContextType | undefined, instance: string): ActorContextType {
  if (!actor) {
    throw new MediaHttpError(401, "AUTHENTICATION_REQUIRED", "Authenticated actor required", instance);
  }
  return actor;
}
