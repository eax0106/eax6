import { createHash } from "node:crypto";
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

export interface GoogleIdentityProviderOptions {
  clientId: string;
  clientSecretRef: string;
  resolveSecret: (reference: string) => Promise<string>;
  fetchImpl?: typeof fetch;
}

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

/**
 * Google has no Organizations, device-code flow, MFA enrollment, or SSO
 * concept — those IdentityProvider methods are Auth0-shaped and unused by
 * Google login. Each user gets a deterministic personal tenant derived from
 * their Google `sub`, matching the documented "personal tenant on signup"
 * behavior, without a separate onboarding step.
 */
export class GoogleIdentityProvider implements IdentityProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly options: GoogleIdentityProviderOptions,
    private readonly sessionStore: SessionStore,
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async createOrganizationInvitation(_request: OrganizationInvitationRequest): Promise<IdentityInvitation> {
    void _request; throw new Error("Workspace invitations require the Auth0 identity provider");
  }
  async revokeOrganizationInvitation(_organizationId: string, _invitationId: string): Promise<void> {
    void _organizationId; void _invitationId; throw new Error("Workspace invitations require the Auth0 identity provider");
  }
  async requestPasswordReset(_email: string, _identityRef: string): Promise<void> {
    void _email; void _identityRef; throw new Error("Change your password with your Google account");
  }

  async getOrCreateOrgForTenant(tenantId: string, _name: string): Promise<string> {
    void _name;
    return tenantId;
  }

  async loginRedirectUrl(request: LoginRedirectRequest): Promise<string> {
    if (request.invitation || request.organizationId) throw new Error("Organization invitations require the Auth0 identity provider");
    const url = new URL(GOOGLE_AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.options.clientId);
    url.searchParams.set("redirect_uri", request.redirectUri);
    url.searchParams.set("scope", "openid profile email");
    url.searchParams.set("state", request.state);
    url.searchParams.set("code_challenge", request.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");

    return url.toString();
  }

  async handleCallback(request: CallbackRequest): Promise<AuthenticatedIdentity> {
    const clientSecret = await this.options.resolveSecret(this.options.clientSecretRef);
    const token = await this.requestJson<GoogleTokenResponse>(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: this.options.clientId,
        client_secret: clientSecret,
        code: request.code,
        redirect_uri: request.redirectUri,
        code_verifier: request.codeVerifier,
      }).toString(),
    });
    const profile = await this.requestJson<GoogleUserInfo>(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });

    return authenticatedIdentityFromProfile(profile);
  }

  async startDeviceAuthorization(): Promise<DeviceAuthorization> {
    throw new Error("Device authorization is not supported by the Google identity provider");
  }

  async pollDeviceToken(_deviceCode: string): Promise<DeviceTokenResult> {
    void _deviceCode;
    return { error: "access_denied" };
  }

  async refreshSession(refreshToken: string): Promise<AuthenticatedIdentity> {
    const clientSecret = await this.options.resolveSecret(this.options.clientSecretRef);
    const token = await this.requestJson<GoogleTokenResponse>(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: this.options.clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }).toString(),
    });
    const profile = await this.requestJson<GoogleUserInfo>(GOOGLE_USERINFO_URL, {
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

  async enrollMfa(_userId: string): Promise<MfaEnrollment> {
    void _userId;
    throw new Error("MFA enrollment is not supported by the Google identity provider");
  }

  async challengeMfa(
    _userId: string,
    _enrollmentId: string,
    _otp: string,
  ): Promise<MfaChallenge> {
    void _userId;
    void _enrollmentId;
    void _otp;
    throw new Error("MFA challenge is not supported by the Google identity provider");
  }

  async configureSso(_tenantId: string, _config: SsoConfig): Promise<SsoConfig> {
    void _tenantId;
    void _config;
    throw new Error("SSO configuration is not supported by the Google identity provider");
  }

  private async requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(url, init);
    if (!response.ok) {
      throw new Error(`Google request failed with status ${response.status}`);
    }
    return (await response.json()) as T;
  }
}

function authenticatedIdentityFromProfile(profile: GoogleUserInfo): AuthenticatedIdentity {
  const userId = deterministicUuidFrom(profile.sub);
  const tenantId = deterministicUuidFrom(`tenant:${profile.sub}`);

  return {
    userId,
    tenantId,
    identityRef: `google|${profile.sub}`,
    email: profile.email,
    emailVerified: profile.email_verified ?? false,
    ...(profile.name ? { displayName: profile.name } : {}),
  };
}

/** Stable UUIDv5-shaped id derived from a Google subject claim, so the same Google account always maps to the same user/tenant id. */
function deterministicUuidFrom(seed: string): string {
  const hash = createHash("sha256").update(seed).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `7${hash.slice(13, 16)}`,
    `8${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

interface GoogleUserInfo {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
}
