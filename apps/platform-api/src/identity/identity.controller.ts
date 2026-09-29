import { createHash, timingSafeEqual } from "node:crypto";
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import type {
  CallbackQueryDto,
  ConfigureSsoDto,
  LoginDto,
  MfaChallengeDto,
  MfaEnrollDto,
  RefreshDto,
} from "./dto/auth.dto";
import { Public, RequireTenantRole } from "../rbac/decorators";
import { IdentityService, type IssuedSession } from "./identity.service";
import { UserProfileRepository } from "./user-profile.repository";
import { IdentityHttpError, problemDetails } from "./problem";

const accessCookieName = "alter_access";
const refreshCookieName = "alter_refresh";

@Controller("/api/v1/auth")
export class IdentityController {
  private readonly logger = new Logger(IdentityController.name);

  constructor(
    private readonly identityService: IdentityService,
    private readonly userProfileRepository: UserProfileRepository,
  ) {}

  @Post("login")
  @Public()
  async login(@Body() body: LoginDto, @Res() reply: FastifyReply): Promise<void> {
    await this.safe(reply, "/api/v1/auth/login", async () => {
      requireFields(body, ["redirectUri", "state", "codeChallenge"]);
      const redirectUrl = await this.identityService.loginRedirectUrl(body);
      reply.status(200).send({ url: redirectUrl });
    });
  }

  @Get("callback")
  @Public()
  async callback(
    @Query() query: CallbackQueryDto,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.safe(reply, "/api/v1/auth/callback", async () => {
      if (!query.code || !query.redirect_uri || !query.code_verifier) {
        throw new IdentityHttpError(400, "INVALID_CALLBACK", "Callback fields missing");
      }

      const session = await this.identityService.handleCallback({
        code: query.code,
        redirectUri: query.redirect_uri,
        codeVerifier: query.code_verifier,
        deviceInfo: {
          userAgent: request.headers["user-agent"],
        },
        ip: request.ip,
      });
      setSessionCookies(reply, session);
      reply.send({ userId: session.userId });
    });
  }

  @Post("refresh")
  @Public()
  async refresh(
    @Body() body: RefreshDto,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.safe(reply, "/api/v1/auth/refresh", async () => {
      const refreshToken = body?.refreshToken ?? readCookie(request, refreshCookieName);
      if (!refreshToken) {
        throw new IdentityHttpError(401, "REFRESH_TOKEN_REQUIRED", "Refresh token required");
      }

      const session = await this.identityService.refreshSession(refreshToken);
      setSessionCookies(reply, session);
      reply.status(200).send({ userId: session.userId });
    });
  }

  @Post("logout")
  @Public()
  async logout(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    await this.safe(reply, "/api/v1/auth/logout", async () => {
      const accessToken = readCookie(request, accessCookieName);
      if (accessToken) {
        const session = await this.identityService.authenticateAccessToken(accessToken);
        await this.identityService.revokeSession(
          session.tenantId,
          session.userId,
          session.id,
        );
      }
      clearSessionCookies(reply);
      reply.status(204).send();
    });
  }

  @Get("sessions")
  @RequireTenantRole("member")
  async sessions(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    await this.safe(reply, "/api/v1/auth/sessions", async () => {
      const session = await this.requireSession(request);
      const sessions = await this.identityService.listActiveSessions(
        session.tenantId,
        session.userId,
      );
      reply.send({ sessions });
    });
  }

  @Get("me")
  @RequireTenantRole("member")
  async me(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    await this.safe(reply, "/api/v1/auth/me", async () => {
      const session = await this.requireSession(request);
      const profile = await this.userProfileRepository.findById(session.userId);
      if (!profile) {
        throw new IdentityHttpError(404, "USER_NOT_FOUND", "User profile not found");
      }
      reply.send({
        userId: session.userId,
        tenantId: session.tenantId,
        email: profile.email,
        name: profile.display_name,
      });
    });
  }

  @Delete("sessions")
  @RequireTenantRole("member")
  async revokeOtherSessions(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    await this.safe(reply, "/api/v1/auth/sessions", async () => {
      const session = await this.requireSession(request);
      const revoked = await this.identityService.revokeOtherSessions(
        session.tenantId,
        session.userId,
        session.id,
      );
      reply.send({ revoked });
    });
  }

  @Patch("me")
  @RequireTenantRole("member")
  async updateMe(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.safe(reply, "/api/v1/auth/me", async () => {
      const session = await this.requireSession(request);
      const name = (body as { name?: unknown } | null)?.name;
      if (typeof name !== "string" || name.trim().length === 0 || name.trim().length > 120) {
        throw new IdentityHttpError(400, "INVALID_PROFILE", "name must be 1 to 120 characters");
      }
      const profile = await this.userProfileRepository.updateDisplayName(session.userId, name.trim());
      if (!profile) {
        throw new IdentityHttpError(404, "USER_NOT_FOUND", "User profile not found");
      }
      reply.send({
        userId: session.userId,
        tenantId: session.tenantId,
        email: profile.email,
        name: profile.display_name,
      });
    });
  }

  @Delete("sessions/:id")
  @RequireTenantRole("member")
  async revokeSession(
    @Param("id") sessionId: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.safe(reply, `/api/v1/auth/sessions/${sessionId}`, async () => {
      const session = await this.requireSession(request);
      await this.identityService.revokeSession(session.tenantId, session.userId, sessionId);
      reply.status(204).send();
    });
  }

  @Post("mfa/enroll")
  @RequireTenantRole("member")
  async enrollMfa(
    @Body() body: MfaEnrollDto,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.safe(reply, "/api/v1/auth/mfa/enroll", async () => {
      const session = await this.requireSession(request);
      rejectMfaTargetOverride(body.userId);
      // The enrolling user is the authenticated session, full stop. Accepting
      // body.userId let any session enrol an authenticator against any account.
      const enrollment = await this.identityService.enrollMfa(session.userId);
      reply.status(200).send(enrollment);
    });
  }

  @Post("mfa/challenge")
  @RequireTenantRole("member")
  async challengeMfa(
    @Body() body: MfaChallengeDto,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.safe(reply, "/api/v1/auth/mfa/challenge", async () => {
      requireFields(body, ["enrollmentId", "otp"]);
      const session = await this.requireSession(request);
      rejectMfaTargetOverride(body.userId);
      const challenge = await this.identityService.challengeMfa(
        session.userId,
        body.enrollmentId,
        body.otp,
      );
      reply.status(200).send(challenge);
    });
  }

  /**
   * Internal, service-authenticated. `x-alter-internal: true` was a
   * client-supplied header, so anyone could set it and configure SSO for any
   * tenant via body.tenantId -- full takeover of that tenant. Replaced with the
   * hashed shared-secret check already used by
   * ConnectorHealthSweepController and NotificationDigestSchedulerController.
   */
  @Post("sso/configure")
  @Public()
  async configureSso(
    @Body() body: ConfigureSsoDto,
    @Headers("authorization") authorization: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.safe(reply, "/api/v1/auth/sso/configure", async () => {
      authorizeInternalCaller(authorization);
      requireFields(body, ["tenantId", "config"]);
      const config = await this.identityService.configureSso(body.tenantId, body.config);
      reply.status(200).send({ config });
    });
  }

  private async requireSession(request: FastifyRequest) {
    const accessToken = readCookie(request, accessCookieName);
    if (!accessToken) {
      throw new IdentityHttpError(401, "ACCESS_TOKEN_REQUIRED", "Access token required");
    }

    return this.identityService.authenticateAccessToken(accessToken);
  }

  private async safe(
    reply: FastifyReply,
    instance: string,
    handler: () => Promise<void>,
  ): Promise<void> {
    try {
      await handler();
    } catch (error) {
      const requestId = reply.getHeader("x-request-id")?.toString();
      const problem = problemDetails(error, instance, requestId);
      if (problem.status >= 500) {
        this.logger.error(
          `${instance} failed: ${error instanceof Error ? error.stack : String(error)}`,
        );
      }
      reply.status(problem.status).type("application/problem+json").send(problem);
    }
  }
}

function setSessionCookies(reply: FastifyReply, session: IssuedSession): void {
  reply.header("Set-Cookie", [
    serializeCookie(accessCookieName, session.accessToken, session.accessMaxAgeSeconds),
    serializeCookie(refreshCookieName, session.refreshToken, session.refreshMaxAgeSeconds),
  ]);
}

function clearSessionCookies(reply: FastifyReply): void {
  reply.header("Set-Cookie", [
    serializeCookie(accessCookieName, "", 0),
    serializeCookie(refreshCookieName, "", 0),
  ]);
}

function serializeCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) {
    return undefined;
  }

  return header
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function requireFields<T extends object>(
  body: T,
  fields: Array<keyof T>,
): void {
  for (const field of fields) {
    if (!body[field]) {
      throw new IdentityHttpError(400, "INVALID_REQUEST_BODY", `${String(field)} required`);
    }
  }
}

/**
 * Constant-time check of the shared internal service credential. Compares
 * SHA-256 digests so a length difference cannot be probed, and fails closed
 * when the secret is unset rather than degrading to "allow".
 */
function authorizeInternalCaller(authorization: string | undefined): void {
  const configured = process.env["INTERNAL_SERVICE_TOKEN_SHA256"]?.trim() ?? "";
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  if (configured.length !== 64 || !token) {
    throw new IdentityHttpError(403, "SSO_CONFIG_FORBIDDEN", "SSO config forbidden");
  }
  const actual = createHash("sha256").update(token).digest();
  const expected = Buffer.from(configured, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(actual, expected)) {
    throw new IdentityHttpError(403, "SSO_CONFIG_FORBIDDEN", "SSO config forbidden");
  }
}

function rejectMfaTargetOverride(userId: string | undefined): void {
  if (userId !== undefined) {
    throw new IdentityHttpError(
      400,
      "MFA_TARGET_OVERRIDE_FORBIDDEN",
      "MFA enrollment and challenge always target the authenticated user",
    );
  }
}
