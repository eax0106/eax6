import { Body, Controller, Headers, Post, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Public } from "../rbac/decorators";
import { PlatformHttpError } from "./problem";
import { SignupService } from "./signup.service";

interface SignupBody {
  invitation?: string;
  code?: string;
  redirectUri?: string;
  codeVerifier?: string;
}

@Controller("/api/v1/signup")
export class SignupController {
  constructor(private readonly signupService: SignupService) {}

  @Public()
  @Post()
  async signup(
    @Body() body: SignupBody,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (!body.code || !body.redirectUri || !body.codeVerifier) {
      throw new PlatformHttpError(
        400,
        "INVALID_SIGNUP_REQUEST",
        "code, redirectUri, and codeVerifier are required",
        "/api/v1/signup",
      );
    }
    if (body.invitation !== undefined && (typeof body.invitation !== "string" || !body.invitation || body.invitation.length > 4096)) {
      throw new PlatformHttpError(400, "INVALID_INVITATION", "Valid invitation context required", "/api/v1/signup");
    }
    const landing = await this.signupService.signup({
      code: body.code,
      redirectUri: body.redirectUri,
      codeVerifier: body.codeVerifier,
      ...(body.invitation !== undefined ? { invitation: body.invitation } : {}),
      idempotencyKey: idempotencyKey ?? "",
      deviceInfo: { userAgent: request.headers["user-agent"] },
      ip: request.ip,
    });
    reply.header("Set-Cookie", [
      cookie("alter_access", landing.session.accessToken, landing.session.accessMaxAgeSeconds),
      cookie(
        "alter_refresh",
        landing.session.refreshToken,
        landing.session.refreshMaxAgeSeconds,
      ),
    ]);
    const { session: _session, ...bodyWithoutSession } = landing;
    void _session;
    reply.status(landing.returning ? 200 : 201).send(bodyWithoutSession);
  }
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}
