import { z } from "zod";
import { randomUUID } from "node:crypto";
import type {
  AuthenticatedIdentity,
  CallbackRequest,
  DeviceAuthorization,
  DeviceTokenResult,
  IdentityProvider,
  IdentityInvitation,
  OrganizationInvitationRequest,
  LoginRedirectRequest,
  MfaChallenge,
  MfaEnrollment,
  SessionRecord,
  SsoConfig,
} from "../../identity-provider.interface";
import { InMemorySessionStore, type SessionStore } from "../../session-store";
import {
  InMemorySsoConfigStore,
  normalizedSsoConfig,
  type SsoConfigStore,
} from "../../sso-config-store";

export class MockIdentityProvider implements IdentityProvider {
  private readonly orgs = new Map<string, string>();
  private readonly identities = new Map<string, AuthenticatedIdentity>();
  private readonly invitations = new Map<string, { invitation: IdentityInvitation; email: string; revoked: boolean }>();
  readonly passwordResetRequests: string[] = [];
  private readonly devicePolls = new Map<string, number>();

  constructor(
    private readonly sessionStore: SessionStore = new InMemorySessionStore(),
    private readonly ssoConfigStore: SsoConfigStore = new InMemorySsoConfigStore(),
  ) {}

  async createOrganizationInvitation(request: OrganizationInvitationRequest): Promise<IdentityInvitation> {
    z.object({ organizationId: z.string().min(1).max(50), email: z.string().email().max(320), inviterName: z.string().trim().min(1).max(300) }).strict().parse(request);
    const ticket = randomUUID(), id = `uinv_${randomUUID()}`, url = new URL("https://mock.identity.local/login");
    url.searchParams.set("organization", request.organizationId); url.searchParams.set("invitation", ticket);
    const invitation = { id, organizationId: request.organizationId, invitationUrl: url.href, expiresAt: new Date(Date.now() + 604800000).toISOString() };
    this.invitations.set(ticket, { invitation, email: request.email.toLowerCase(), revoked: false });
    return { ...invitation };
  }

  async revokeOrganizationInvitation(organizationId: string, invitationId: string): Promise<void> {
    const entry = [...this.invitations.values()].find(value => value.invitation.id === invitationId && value.invitation.organizationId === organizationId);
    if (entry) entry.revoked = true;
  }

  async requestPasswordReset(email: string, identityRef: string): Promise<void> {
    z.string().email().max(320).parse(email);
    if (!identityRef.startsWith("auth0|") && !identityRef.startsWith("mock|")) throw new Error("Change your password with your sign-in provider");
    this.passwordResetRequests.push(email);
  }

  async getOrCreateOrgForTenant(tenantId: string, name: string): Promise<string> {
    const existing = this.orgs.get(tenantId);
    if (existing) {
      return existing;
    }

    void name;
    const orgId = `org_${tenantId.replaceAll("-", "")}`;
    this.orgs.set(tenantId, orgId);
    return orgId;
  }

  async loginRedirectUrl(request: LoginRedirectRequest): Promise<string> {
    const url = new URL("https://mock.identity.local/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", "mock-client");
    url.searchParams.set("redirect_uri", request.redirectUri);
    url.searchParams.set("state", request.state);
    url.searchParams.set("code_challenge", request.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (request.organizationId) {
      url.searchParams.set("organization", request.organizationId);
    }
    if (request.invitation) {
      const entry = this.invitations.get(request.invitation);
      if (!entry || entry.revoked || Date.parse(entry.invitation.expiresAt) <= Date.now() || entry.invitation.organizationId !== request.organizationId) throw new Error("Invitation is unavailable");
      url.searchParams.set("invitation", request.invitation);
    }
    if (request.connection) {
      url.searchParams.set("connection", request.connection);
    }

    return url.toString();
  }

  async handleCallback(request: CallbackRequest): Promise<AuthenticatedIdentity> {
    if (request.code.startsWith("invite:")) {
      const entry = this.invitations.get(request.code.slice(7));
      if (!entry || entry.revoked || Date.parse(entry.invitation.expiresAt) <= Date.now()) throw new Error("Invitation is unavailable");
      const identityRef = `mock|${entry.email}`;
      const current = [...this.identities.values()].find(value => value.identityRef === identityRef);
      const identity = { userId: current?.userId ?? randomUUID(), tenantId: entry.invitation.organizationId, organizationId: entry.invitation.organizationId,
        identityRef, email: entry.email, emailVerified: true, displayName: entry.email.split("@")[0]! };
      this.identities.set(identity.userId, identity); return identity;
    }
    const userId = request.code.startsWith("user:")
      ? request.code.slice("user:".length)
      : "00000000-0000-7000-8000-000000000101";
    const tenantId = "00000000-0000-7000-8000-000000000001";
    const identity = {
      userId,
      tenantId,
      identityRef: `auth0|${userId}`,
      email: "mock.user@example.com",
      emailVerified: true,
      displayName: "Mock User",
    };

    this.identities.set(userId, identity);
    return identity;
  }

  async startDeviceAuthorization(): Promise<DeviceAuthorization> {
    const deviceCode = `device_${randomUUID()}`;
    this.devicePolls.set(deviceCode, 0);
    return {
      deviceCode,
      userCode: "MOCK-CODE",
      verificationUri: "https://mock.identity.local/activate",
      verificationUriComplete: "https://mock.identity.local/activate?user_code=MOCK-CODE",
      expiresIn: 600,
      interval: 5,
    };
  }

  async pollDeviceToken(deviceCode: string): Promise<DeviceTokenResult> {
    const polls = this.devicePolls.get(deviceCode);
    if (polls === undefined) return { error: "expired_token" };
    if (polls === 0) {
      this.devicePolls.set(deviceCode, 1);
      return { error: "authorization_pending" };
    }
    return {
      accessToken: `mock-access-${deviceCode}`,
      refreshToken: `mock-refresh-${deviceCode}`,
      expiresIn: 3600,
      tokenType: "Bearer",
    };
  }

  async refreshSession(_refreshToken: string): Promise<AuthenticatedIdentity> {
    void _refreshToken;
    return {
      userId: "00000000-0000-7000-8000-000000000101",
      tenantId: "00000000-0000-7000-8000-000000000001",
      identityRef: "auth0|00000000-0000-7000-8000-000000000101",
      email: "mock.user@example.com",
      emailVerified: true,
      displayName: "Mock User",
    };
  }

  async listActiveSessions(tenantId: string, userId: string): Promise<SessionRecord[]> {
    return this.sessionStore.listActive(tenantId, userId);
  }

  async revokeSession(tenantId: string, userId: string, sessionId: string): Promise<void> {
    await this.sessionStore.revoke(tenantId, userId, sessionId);
  }

  async enrollMfa(userId: string): Promise<MfaEnrollment> {
    return {
      enrollmentId: `mfa_${userId.slice(0, 8)}_${randomUUID()}`,
      barcodeUri: "otpauth://totp/Alter:mock.user@example.com",
      recoveryCodes: ["mock-recovery-code"],
    };
  }

  async challengeMfa(
    _userId: string,
    enrollmentId: string,
    otp: string,
  ): Promise<MfaChallenge> {
    return {
      challengeId: `chal_${enrollmentId}`,
      status: otp === "000000" ? "rejected" : "verified",
    };
  }

  async configureSso(tenantId: string, config: SsoConfig): Promise<SsoConfig> {
    const persistedConfig = normalizedSsoConfig(config);
    await this.ssoConfigStore.save(tenantId, persistedConfig);
    return persistedConfig;
  }
}
