import type { ConnectorId, ConnectorTenantConfig } from "./connectors";

export interface ConnectorCatalogEntry {
  readonly id: ConnectorId;
  readonly display_name: string;
  readonly scopes: readonly string[];
  readonly pkce: boolean;
  readonly configured: boolean;
}

export interface OAuthAuthorizeInput {
  readonly redirect_uri: string;
  readonly tenant_config?: ConnectorTenantConfig;
}

export interface WorkspaceConnectorConfigRecord {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly connector: ConnectorId;
  readonly config: ConnectorTenantConfig;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OAuthAuthorizeView {
  readonly authorize_url: string;
  readonly state: string;
  readonly expires_at: string;
}

export interface OAuthCallbackInput {
  readonly code: string;
  readonly state: string;
}

export interface OAuthStateRecord {
  readonly tenantId: string;
  readonly id: string;
  readonly workspaceId: string;
  readonly connector: ConnectorId;
  readonly codeVerifier: string | null;
  readonly redirectUri: string;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export type OAuthConnectionStatus = "connected" | "revoked" | "error";

export interface OAuthConnectionRecord {
  readonly tenantId: string;
  readonly id: string;
  readonly workspaceId: string;
  readonly connector: ConnectorId;
  readonly sourceRevision: number;
  readonly externalAccountId: string;
  readonly scopes: string;
  readonly status: OAuthConnectionStatus;
  readonly lastHealthStatus: string | null;
  readonly lastHealthCheckedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly useAuditPtr: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OAuthConnectionView {
  readonly id: string;
  readonly connector: ConnectorId;
  readonly external_account_id: string;
  readonly scopes: readonly string[];
  readonly status: OAuthConnectionStatus;
  readonly last_health_status: string | null;
  readonly last_health_checked_at: string | null;
  readonly created_at: string;
  readonly version: string;
  readonly engine_synced?: boolean;
}

export interface OAuthRevokeView extends OAuthConnectionView {
  readonly revoked_remotely: boolean;
  readonly revoke_disclosure?: string;
}

export interface OAuthScopesView {
  readonly connection_id: string;
  readonly scopes: readonly string[];
}

export interface IntegrationActivityQuery {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface OAuthConnectionActivityRecord {
  readonly tenantId: string;
  readonly id: string;
  readonly connectionId: string;
  readonly action: string;
  readonly usedAt: Date;
}

export interface OAuthConnectionActivityView {
  readonly id: string;
  readonly connection_id: string;
  readonly action: string;
  readonly used_at: string;
}

export interface OAuthConnectionActivityPage {
  readonly data: readonly OAuthConnectionActivityView[];
  readonly page: {
    readonly next_cursor: string | null;
    readonly has_more: boolean;
    readonly limit: number;
  };
}

export const integrationDeferredCapabilities = [
  {
    capability: "oauth_round_trip_verified",
    status: "NOT_MET",
    reason:
      "Real provider credentials are not provisioned in this environment. Unit paths are verified, while each new connector's real identity-endpoint harness remains skip-gated by its *_LIVE_TEST flag and access token.",
  },
  {
    capability: "oauth_round_trip_verified_slack",
    status: "NOT_MET",
    reason:
      "Uses Sign in with Slack (OIDC) endpoints, not the classic bot-install oauth.v2.access flow. authorize/callback/userinfo/revoke code paths are real, but unexercised against a live Slack app -- in particular unverified: whether PKCE is safe to enable for our app (left off pending confirmation) and whether auth.revoke's ok-field handling matches a real failure response. Flip to MET once SLACK_OAUTH_CLIENT_ID_SECRET_REF/SLACK_OAUTH_CLIENT_SECRET_REF resolve to real credentials and a live round-trip test is run.",
  },
  {
    capability: "oauth_round_trip_verified_hubspot",
    status: "NOT_MET",
    reason:
      "authorize/callback code paths are real, but unexercised against a live HubSpot app. In particular unverified: the hub_id extraction from GET /oauth/v1/access-tokens/{token}, and the legacy DELETE /oauth/v1/refresh-tokens/{token} revoke path (HubSpot documents this API as being replaced by a dated 2026-03+ revoke endpoint we have not adopted). Flip to MET once HUBSPOT_OAUTH_CLIENT_ID_SECRET_REF/HUBSPOT_OAUTH_CLIENT_SECRET_REF resolve to real credentials and a live round-trip test is run.",
  },
  {
    capability: "oauth_round_trip_verified_linkedin",
    status: "NOT_MET",
    reason:
      "authorize/callback/userinfo code paths are real, but unexercised against a live LinkedIn app. LinkedIn has no documented revoke endpoint at all -- revoke is local-invalidation-only by design, not a gap to close. Flip to MET once LINKEDIN_OAUTH_CLIENT_ID_SECRET_REF/LINKEDIN_OAUTH_CLIENT_SECRET_REF resolve to real credentials and a live round-trip test is run.",
  },
  {
    capability: "oauth_round_trip_verified_zendesk",
    status: "NOT_MET",
    reason:
      "authorize/callback/userinfo/revoke code paths are real, including per-tenant subdomain resolution, but unexercised against a live Zendesk app. Flip to MET once ZENDESK_OAUTH_CLIENT_ID_SECRET_REF/ZENDESK_OAUTH_CLIENT_SECRET_REF resolve to real credentials, a real subdomain is configured, and a live round-trip test is run.",
  },
  {
    capability: "oauth_round_trip_verified_salesforce",
    status: "NOT_MET",
    reason:
      "authorize/callback/userinfo/revoke code paths are real, including per-tenant login-host resolution, but unexercised against a live Salesforce org. Flip to MET once SALESFORCE_OAUTH_CLIENT_ID_SECRET_REF/SALESFORCE_OAUTH_CLIENT_SECRET_REF resolve to real credentials, a real login host is configured, and a live round-trip test is run.",
  },
  {
    capability: "oauth_round_trip_verified_shopify",
    status: "NOT_MET",
    reason:
      "authorize/callback/userinfo code paths are real, including per-tenant shop-domain resolution. Shopify has no documented OAuth revoke endpoint -- revoke is local-invalidation-only by design, not a gap to close. Flip to MET once SHOPIFY_OAUTH_CLIENT_ID_SECRET_REF/SHOPIFY_OAUTH_CLIENT_SECRET_REF resolve to real credentials, a real shop domain is configured, and a live round-trip test is run.",
  },
  {
    capability: "oauth_round_trip_verified_x",
    status: "NOT_MET",
    reason:
      "authorize/callback/userinfo/revoke code paths are real, including the Basic-auth client-credentials variant X requires. Flip to MET once X_OAUTH_CLIENT_ID_SECRET_REF/X_OAUTH_CLIENT_SECRET_REF resolve to real credentials and a live round-trip test is run.",
  },
  {
    capability: "oauth_round_trip_verified_m365",
    status: "NOT_MET",
    reason:
      "authorize/callback/userinfo code paths are real, including per-tenant identity-origin resolution. Microsoft Graph has no documented per-app OAuth revoke endpoint reachable from this flow -- revoke is local-invalidation-only by design, not a gap to close. Flip to MET once M365_OAUTH_CLIENT_ID_SECRET_REF/M365_OAUTH_CLIENT_SECRET_REF resolve to real credentials, a real tenant is configured, and a live round-trip test is run.",
  },
] as const;
