import { randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import type {
  IdentityProvider,
  MfaChallenge,
  MfaEnrollment,
  SessionRecord,
  SsoConfig,
} from "./identity-provider.interface";
import { IdentityHttpError } from "./problem";
import { hashToken, type SessionStore } from "./session-store";
import type { LoginDto } from "./dto/auth.dto";
import {
  streamRevocationBus,
  type StreamRevocationBus,
} from "../streaming/revocation";

export interface IssuedSession {
  sessionId: string;
  userId: string;
  tenantId: string;
  accessToken: string;
  refreshToken: string;
  accessMaxAgeSeconds: number;
  refreshMaxAgeSeconds: number;
}

const accessMaxAgeSeconds = 15 * 60;
const refreshMaxAgeSeconds = 30 * 24 * 60 * 60;

@Injectable()
export class IdentityService {
  constructor(
    private readonly identityProvider: IdentityProvider,
    private readonly sessionStore: SessionStore,
    private readonly revocations: StreamRevocationBus = streamRevocationBus,
  ) {}

  loginRedirectUrl(request: LoginDto): Promise<string> {
    return this.identityProvider.loginRedirectUrl(request);
  }

  async handleCallback(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    deviceInfo?: Record<string, unknown>;
    ip?: string;
  }): Promise<IssuedSession> {
    const identity = await this.identityProvider.handleCallback({
      code: input.code,
      redirectUri: input.redirectUri,
      codeVerifier: input.codeVerifier,
    });

    return this.issueSession(identity.userId, identity.tenantId, input.deviceInfo, input.ip);
  }

  async refreshSession(refreshToken: string): Promise<IssuedSession> {
    const tenantId = tenantIdFromToken(refreshToken);
    const previousHash = hashToken(refreshToken);
    const session = await this.sessionStore.findByRefreshTokenHash(tenantId, previousHash);
    if (!session) {
      throw new IdentityHttpError(401, "INVALID_REFRESH_TOKEN", "Refresh token rejected");
    }

    const nextAccessToken = newToken(tenantId);
    const nextRefreshToken = newToken(tenantId);
    const rotated = await this.sessionStore.rotateRefreshToken(
      tenantId,
      session.id,
      previousHash,
      hashToken(nextRefreshToken),
      hashToken(nextAccessToken),
    );

    if (!rotated) {
      throw new IdentityHttpError(401, "INVALID_REFRESH_TOKEN", "Refresh token rejected");
    }

    return {
      sessionId: session.id,
      userId: session.userId,
      tenantId: session.tenantId,
      accessToken: nextAccessToken,
      refreshToken: nextRefreshToken,
      accessMaxAgeSeconds,
      refreshMaxAgeSeconds,
    };
  }

  async authenticateAccessToken(accessToken: string): Promise<SessionRecord> {
    const tenantId = tenantIdFromToken(accessToken);
    const session = await this.sessionStore.findByAccessTokenHash(
      tenantId,
      hashToken(accessToken),
    );
    if (!session) {
      throw new IdentityHttpError(401, "INVALID_ACCESS_TOKEN", "Access token rejected");
    }

    return session;
  }

  issueSignupSession(
    userId: string,
    tenantId: string,
    deviceInfo?: Record<string, unknown>,
    ip?: string,
  ): Promise<IssuedSession> {
    return this.issueSession(userId, tenantId, deviceInfo, ip);
  }

  listActiveSessions(tenantId: string, userId: string): Promise<SessionRecord[]> {
    return this.identityProvider.listActiveSessions(tenantId, userId);
  }

  async revokeSession(tenantId: string, userId: string, sessionId: string): Promise<void> {
    await this.identityProvider.revokeSession(tenantId, userId, sessionId);
    this.revocations.publish({ tenantId, userId, sessionId });
  }

  /** Signs the user out everywhere except the session making the request. */
  async revokeOtherSessions(tenantId: string, userId: string, keepSessionId: string): Promise<number> {
    const sessions = await this.identityProvider.listActiveSessions(tenantId, userId);
    let revoked = 0;
    for (const session of sessions) {
      if (session.id === keepSessionId) continue;
      await this.revokeSession(tenantId, userId, session.id);
      revoked += 1;
    }
    return revoked;
  }

  enrollMfa(userId: string): Promise<MfaEnrollment> {
    return this.identityProvider.enrollMfa(userId);
  }

  challengeMfa(
    userId: string,
    enrollmentId: string,
    otp: string,
  ): Promise<MfaChallenge> {
    return this.identityProvider.challengeMfa(userId, enrollmentId, otp);
  }

  configureSso(tenantId: string, config: SsoConfig): Promise<SsoConfig> {
    return this.identityProvider.configureSso(tenantId, config);
  }

  private async issueSession(
    userId: string,
    tenantId: string,
    deviceInfo?: Record<string, unknown>,
    ip?: string,
  ): Promise<IssuedSession> {
    const accessToken = newToken(tenantId);
    const refreshToken = newToken(tenantId);

    const input: Parameters<SessionStore["create"]>[0] = {
      userId,
      tenantId,
      accessTokenHash: hashToken(accessToken),
      refreshTokenHash: hashToken(refreshToken),
    };
    if (deviceInfo) {
      input.deviceInfo = deviceInfo;
    }
    if (ip) {
      input.ip = ip;
    }

    const session = await this.sessionStore.create(input);

    return {
      sessionId: session.id,
      userId,
      tenantId,
      accessToken,
      refreshToken,
      accessMaxAgeSeconds,
      refreshMaxAgeSeconds,
    };
  }
}

function newToken(tenantId: string): string {
  return `${tenantId}.${randomBytes(32).toString("base64url")}`;
}

function tenantIdFromToken(token: string): string {
  const separator = token.indexOf(".");
  if (separator <= 0) {
    throw new IdentityHttpError(401, "INVALID_SESSION_TOKEN", "Session token rejected");
  }
  return token.slice(0, separator);
}
