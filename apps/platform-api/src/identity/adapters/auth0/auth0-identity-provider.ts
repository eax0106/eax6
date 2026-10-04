import { z } from "zod";
import { M2mValidator } from "@alterx/auth";
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
import type { SessionStore } from "../../session-store";
import {
  normalizedSsoConfig,
  type SsoConfigStore,
} from "../../sso-config-store";

export interface Auth0IdentityProviderOptions {
  domain: string;
  clientId: string;
  clientSecretRef?: string;
  m2mClientId?: string;
  m2mClientSecretRef?: string;
  resolveSecret?: (reference: string) => Promise<string>;
  managementToken?: string;
  fetchImpl?: typeof fetch;
}

export class Auth0IdentityProvider implements IdentityProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly issuer: string;
  private readonly idTokenValidator: M2mValidator;
  private cachedManagementToken?: { token: string; expiresAt: number };

  constructor(
    private readonly options: Auth0IdentityProviderOptions,
    private readonly sessionStore: SessionStore,
    private readonly ssoConfigStore: SsoConfigStore,
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.issuer = `https://${options.domain}`;
    // Reuse the shared RS256/JWKS verifier for issuer, audience and lifetime;
    // ID-token subject, authorized party and organization are checked below.
    this.idTokenValidator = new M2mValidator({ auth0Domain: options.domain, apiAudience: options.clientId }, {
      fetch: async url => this.fetchImpl(url, { signal: AbortSignal.timeout(10000) }),
    });
  }

  async getOrCreateOrgForTenant(tenantId: string, name: string): Promise<string> {
    const existing = await this.managementJson<{ organizations: Array<{ id: string }> }>(
      `/api/v2/organizations?name=${encodeURIComponent(tenantId)}`,
    );
    const organization = existing.organizations.at(0);
    if (organization) {
      return organization.id;
    }

    const created = await this.managementJson<{ id: string }>("/api/v2/organizations", {
      method: "POST",
      body: JSON.stringify({
        name: tenantId,
        display_name: name,
        metadata: { alter_tenant_id: tenantId },
      }),
    });

    return created.id;
  }

  async createOrganizationInvitation(input: OrganizationInvitationRequest): Promise<IdentityInvitation> {
    const request = z.object({ organizationId: z.string().min(1).max(50), email: z.string().email().max(320), inviterName: z.string().trim().min(1).max(300) }).strict().parse(input);
    const response = await this.managementJson<unknown>(`/api/v2/organizations/${encodeURIComponent(request.organizationId)}/invitations`, {
      method: "POST", signal: AbortSignal.timeout(10000), body: JSON.stringify({ inviter: { name: request.inviterName }, invitee: { email: request.email },
        client_id: this.options.clientId, ttl_sec: 604800, send_invitation_email: true }),
    });
    const invitation = z.object({ id: z.string().min(1).max(128), organization_id: z.string(), client_id: z.string(), invitee: z.object({ email: z.string().email() }),
      invitation_url: z.string().url(), expires_at: z.string().datetime() }).parse(response);
    const url = new URL(invitation.invitation_url), expiry = Date.parse(invitation.expires_at);
    if (invitation.organization_id !== request.organizationId || invitation.client_id !== this.options.clientId || invitation.invitee.email.toLowerCase() !== request.email.toLowerCase()
      || url.protocol !== "https:" || url.username || url.password || url.searchParams.get("organization") !== request.organizationId || !url.searchParams.get("invitation")
      || expiry <= Date.now() || expiry > Date.now() + 604860000) throw new Error("Auth0 returned an invalid organization invitation");
    return { id: invitation.id, organizationId: invitation.organization_id, invitationUrl: invitation.invitation_url, expiresAt: invitation.expires_at };
  }

  async revokeOrganizationInvitation(organizationId: string, invitationId: string): Promise<void> {
    if (!organizationId || !invitationId) throw new Error("Organization invitation identity required");
    const token = await this.managementToken();
    const response = await this.fetchImpl(`${this.issuer}/api/v2/organizations/${encodeURIComponent(organizationId)}/invitations/${encodeURIComponent(invitationId)}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
    });
    if (!response.ok && response.status !== 404) throw new Error(`Auth0 invitation cancellation failed with status ${response.status}`);
  }

  async requestPasswordReset(email: string, identityRef: string): Promise<void> {
    z.string().email().max(320).parse(email);
    if (!identityRef.startsWith("auth0|")) throw new Error("Change your password with your sign-in provider");
    const response = await this.fetchImpl(`${this.issuer}/dbconnections/change_password`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: this.options.clientId, email, connection: "Username-Password-Authentication" }), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Auth0 password reset failed with status ${response.status}`);
  }

  async loginRedirectUrl(request: LoginRedirectRequest): Promise<string> {
    const url = new URL(`${this.issuer}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.options.clientId);
    url.searchParams.set("redirect_uri", request.redirectUri);
    url.searchParams.set("scope", "openid profile email offline_access");
    url.searchParams.set("state", request.state);
    url.searchParams.set("code_challenge", request.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (request.organizationId) {
      url.searchParams.set("organization", request.organizationId);
    }
    if (request.invitation) {
      if (!request.organizationId) throw new Error("Invitation organization required");
      url.searchParams.set("invitation", request.invitation);
    }
    if (request.connection) {
      url.searchParams.set("connection", request.connection);
    }

    return url.toString();
  }

  async handleCallback(request: CallbackRequest): Promise<AuthenticatedIdentity> {
    const clientSecret = await this.resolveSecret(this.options.clientSecretRef);
    const token = await this.authJson<Auth0TokenResponse>("/oauth/token", {
      method: "POST",
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: this.options.clientId,
        client_secret: clientSecret,
        code: request.code,
        redirect_uri: request.redirectUri,
        code_verifier: request.codeVerifier,
      }),
    });
    const profile = await this.authJson<Auth0Profile>("/userinfo", {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });

    if (typeof token.id_token !== "string" || !token.id_token || token.id_token.length > 16384) throw new Error("Auth0 ID token is required");
    const { claims } = await this.idTokenValidator.validate(`Bearer ${token.id_token}`);
    if (typeof claims.sub !== "string" || !claims.sub || claims.sub !== profile.sub ||
      (claims.azp !== undefined && claims.azp !== this.options.clientId) ||
      (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== this.options.clientId) ||
      (claims.org_id !== undefined && (typeof claims.org_id !== "string" || !claims.org_id || claims.org_id.length > 50)) ||
      (profile.org_id !== undefined && profile.org_id !== claims.org_id)) throw new Error("Auth0 ID token context is invalid");
    return authenticatedIdentityFromProfile({ ...profile, ...(typeof claims.org_id === "string" ? { org_id: claims.org_id } : {}) });
  }

  async startDeviceAuthorization(): Promise<DeviceAuthorization> {
    const response = await this.fetchImpl(`${this.issuer}/oauth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.options.clientId,
        scope: "openid profile email offline_access",
      }).toString(),
    });
    if (!response.ok) {
      throw new Error(`Auth0 request failed with status ${response.status}`);
    }
    const body = (await response.json()) as Auth0DeviceAuthorizationResponse;
    if (
      !body.device_code ||
      !body.user_code ||
      !body.verification_uri ||
      !Number.isFinite(body.expires_in) ||
      !Number.isFinite(body.interval)
    ) {
      throw new Error("Auth0 device authorization response was invalid");
    }
    return {
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri: body.verification_uri,
      ...(body.verification_uri_complete
        ? { verificationUriComplete: body.verification_uri_complete }
        : {}),
      expiresIn: body.expires_in!,
      interval: body.interval!,
    };
  }

  async pollDeviceToken(deviceCode: string): Promise<DeviceTokenResult> {
    const response = await this.fetchImpl(`${this.issuer}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: this.options.clientId,
      }).toString(),
    });
    const body = (await response.json()) as Auth0DeviceTokenResponse;
    if (!response.ok) {
      if (isDeviceTokenError(body.error)) {
        return { error: body.error };
      }
      throw new Error(`Auth0 request failed with status ${response.status}`);
    }
    if (!body.access_token || !Number.isFinite(body.expires_in)) {
      throw new Error("Auth0 device token response was invalid");
    }
    return {
      accessToken: body.access_token,
      ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
      expiresIn: body.expires_in!,
      tokenType: "Bearer",
    };
  }

  async refreshSession(refreshToken: string): Promise<AuthenticatedIdentity> {
    const clientSecret = await this.resolveSecret(this.options.clientSecretRef);
    const token = await this.authJson<Auth0TokenResponse>("/oauth/token", {
      method: "POST",
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: this.options.clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    });
    const profile = await this.authJson<Auth0Profile>("/userinfo", {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });

    return authenticatedIdentityFromProfile(profile);
  }

  async listActiveSessions(tenantId: string, userId: string): Promise<SessionRecord[]> {
    return this.sessionStore.listActive(tenantId, userId);
  }

  async revokeSession(tenantId: string, userId: string, sessionId: string): Promise<void> {
    await this.sessionStore.revoke(tenantId, userId, sessionId);
  }

  async enrollMfa(userId: string): Promise<MfaEnrollment> {
    const enrollment = await this.managementJson<Auth0MfaEnrollment>(
      "/api/v2/guardian/enrollments/ticket",
      {
        method: "POST",
        body: JSON.stringify({ user_id: userId }),
      },
    );

    return {
      enrollmentId: enrollment.ticket_id,
      barcodeUri: enrollment.ticket_url,
    };
  }

  async challengeMfa(
    userId: string,
    enrollmentId: string,
    otp: string,
  ): Promise<MfaChallenge> {
    const challenge = await this.authJson<{ id: string; status?: string }>("/mfa/challenge", {
      method: "POST",
      body: JSON.stringify({
        client_id: this.options.clientId,
        mfa_token: enrollmentId,
        challenge_type: "otp",
        otp,
        user_id: userId,
      }),
    });

    return {
      challengeId: challenge.id,
      status: challenge.status === "rejected" ? "rejected" : "pending",
    };
  }

  async configureSso(tenantId: string, config: SsoConfig): Promise<SsoConfig> {
    const persistedConfig = normalizedSsoConfig(config);
    await this.managementJson(`/api/v2/organizations/${tenantId}`, {
      method: "PATCH",
      body: JSON.stringify({
        metadata: {
          sso_config_type: persistedConfig.type,
        },
      }),
    });
    await this.ssoConfigStore.save(tenantId, persistedConfig);

    return persistedConfig;
  }

  private async authJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    return this.requestJson<T>(`${this.issuer}${path}`, init);
  }

  private async managementJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const managementToken = await this.managementToken();

    return this.requestJson<T>(`${this.issuer}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${managementToken}`,
        ...init.headers,
      },
    });
  }

  private async managementToken(): Promise<string> {
    if (this.options.managementToken) {
      return this.options.managementToken;
    }

    if (
      this.cachedManagementToken &&
      this.cachedManagementToken.expiresAt > Date.now() + 60_000
    ) {
      return this.cachedManagementToken.token;
    }

    if (!this.options.m2mClientId || !this.options.m2mClientSecretRef) {
      throw new Error("Auth0 management credentials unavailable");
    }

    const clientSecret = await this.resolveSecret(this.options.m2mClientSecretRef);
    const response = await this.authJson<Auth0ManagementTokenResponse>("/oauth/token", {
      method: "POST",
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: this.options.m2mClientId,
        client_secret: clientSecret,
        audience: `${this.issuer}/api/v2/`,
      }),
    });
    this.cachedManagementToken = {
      token: response.access_token,
      expiresAt: Date.now() + response.expires_in * 1000,
    };
    return response.access_token;
  }

  private async resolveSecret(reference: string | undefined): Promise<string | undefined> {
    if (!reference) {
      return undefined;
    }
    if (!this.options.resolveSecret) {
      throw new Error("Auth0 secret resolver unavailable");
    }
    return this.options.resolveSecret(reference);
  }

  private async requestJson<T>(url: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(10000),
      headers: {
        "content-type": "application/json",
        ...init.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`Auth0 request failed with status ${response.status}`);
    }

    return (await response.json()) as T;
  }
}

interface Auth0TokenResponse {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
}

interface Auth0DeviceAuthorizationResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
}

interface Auth0DeviceTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
}

function isDeviceTokenError(
  error: string | undefined,
): error is Extract<DeviceTokenResult, { error: string }>["error"] {
  return (
    error === "authorization_pending" ||
    error === "slow_down" ||
    error === "expired_token" ||
    error === "access_denied"
  );
}

interface Auth0ManagementTokenResponse {
  access_token: string;
  expires_in: number;
}

interface Auth0Profile {
  sub: string;
  email: string;
  email_verified?: boolean;
  phone_verified?: boolean;
  name?: string;
  org_id?: string;
  "https://alter.dev/user_id"?: string;
  "https://alter.dev/tenant_id"?: string;
}

interface Auth0MfaEnrollment {
  ticket_id: string;
  ticket_url: string;
}

function authenticatedIdentityFromProfile(profile: Auth0Profile): AuthenticatedIdentity {
  z.object({ sub: z.string().min(1).max(512), email: z.string().email().max(320),
    email_verified: z.boolean().optional(), phone_verified: z.boolean().optional(), name: z.string().max(300).optional(),
    org_id: z.string().min(1).max(50).optional(),
    "https://alter.dev/user_id": z.string().min(1).max(128).optional(),
    "https://alter.dev/tenant_id": z.string().min(1).max(128).optional(),
  }).passthrough().parse(profile);
  const identity: AuthenticatedIdentity = {
    userId: profile["https://alter.dev/user_id"] ?? profile.sub,
    tenantId: profile["https://alter.dev/tenant_id"] ?? profile.org_id ?? "",
    identityRef: profile.sub,
    ...(profile.org_id ? { organizationId: profile.org_id } : {}),
    email: profile.email,
    emailVerified: profile.email_verified === true,
  };
  if (profile.phone_verified !== undefined) {
    identity.phoneVerified = profile.phone_verified;
  }
  if (profile.name) {
    identity.displayName = profile.name;
  }
  return identity;
}
