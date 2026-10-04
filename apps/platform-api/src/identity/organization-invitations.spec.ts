import { describe, expect, it, vi } from "vitest";
import { Auth0IdentityProvider } from "./adapters/auth0/auth0-identity-provider";
import { MockIdentityProvider } from "./adapters/mock/mock-identity-provider";
import { GoogleIdentityProvider } from "./adapters/google/google-identity-provider";
import { InMemorySessionStore } from "./session-store";
import { InMemorySsoConfigStore } from "./sso-config-store";

const input = { organizationId: "org_native", email: "Invitee@company.test", inviterName: "Workspace administrator" };
const response = () => ({ id: "uinv_native", organization_id: input.organizationId, client_id: "client", invitee: { email: input.email },
  invitation_url: "https://app.example.test/auth/sign-in?organization=org_native&invitation=native-ticket", expires_at: new Date(Date.now() + 604800000).toISOString() });
const provider = (http: typeof fetch) => new Auth0IdentityProvider({ domain: "identity.example.test", clientId: "client", managementToken: "fixture-token", fetchImpl: http }, new InMemorySessionStore(), new InMemorySsoConfigStore());

describe("hybrid invitation identity edge", () => {
  it("creates a seven-day email invitation in the correct Auth0 organization and forwards its ticket on login", async () => {
    const http = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response())), auth0 = provider(http);
    const invitation = await auth0.createOrganizationInvitation(input);
    expect(invitation).toMatchObject({ id: "uinv_native", organizationId: input.organizationId });
    expect(http).toHaveBeenCalledWith("https://identity.example.test/api/v2/organizations/org_native/invitations", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ Authorization: "Bearer fixture-token" }), signal: expect.any(AbortSignal) }));
    const body = JSON.parse(String(http.mock.calls[0]![1]!.body));
    expect(body).toEqual({ inviter: { name: input.inviterName }, invitee: { email: input.email }, client_id: "client", ttl_sec: 604800, send_invitation_email: true });
    const redirect = new URL(await auth0.loginRedirectUrl({ organizationId: input.organizationId, invitation: "native-ticket", redirectUri: "https://app.example.test/auth/callback", state: "state", codeChallenge: "challenge" }));
    expect(redirect.searchParams.get("organization")).toBe(input.organizationId); expect(redirect.searchParams.get("invitation")).toBe("native-ticket");
    expect(redirect.searchParams.get("state")).toBe("state"); expect(redirect.searchParams.get("code_challenge_method")).toBe("S256");
    await expect(auth0.loginRedirectUrl({ invitation: "ticket", redirectUri: "https://app.example.test/auth/callback", state: "state", codeChallenge: "challenge" })).rejects.toThrow("organization required");
  });
  it("rejects invalid provider output, cross-organization links, missing tickets and unsafe delivery responses", async () => {
    for (const patch of [{ organization_id: "org_other" }, { client_id: "other" }, { invitee: { email: "other@company.test" } }, { invitation_url: "http://app.test/?organization=org_native&invitation=token" }, { invitation_url: "https://app.test/?organization=org_other&invitation=token" }, { invitation_url: "https://app.test/?organization=org_native" }, { expires_at: new Date(0).toISOString() }, { expires_at: new Date(Date.now() + 30 * 86400000).toISOString() }]) {
      await expect(provider(vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...response(), ...patch }))).createOrganizationInvitation(input)).rejects.toThrow();
    }
    await expect(provider(vi.fn<typeof fetch>().mockResolvedValue(new Response("refused", { status: 503 }))).createOrganizationInvitation(input)).rejects.toThrow("503");
    const http = vi.fn<typeof fetch>(); await expect(provider(http).createOrganizationInvitation({ ...input, email: "invalid" })).rejects.toThrow(); expect(http).not.toHaveBeenCalled();
  });
  it("cancels only the named organization invitation, handles already cancelled tickets, and surfaces provider failure", async () => {
    const http = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 })), auth0 = provider(http);
    await auth0.revokeOrganizationInvitation("org_native", "uinv_native");
    expect(http).toHaveBeenCalledWith("https://identity.example.test/api/v2/organizations/org_native/invitations/uinv_native", expect.objectContaining({ method: "DELETE", signal: expect.any(AbortSignal) }));
    http.mockResolvedValue(new Response(null, { status: 404 })); await expect(auth0.revokeOrganizationInvitation("org_native", "uinv_native")).resolves.toBeUndefined();
    http.mockResolvedValue(new Response(null, { status: 500 })); await expect(auth0.revokeOrganizationInvitation("org_native", "uinv_native")).rejects.toThrow("500");
    await expect(auth0.revokeOrganizationInvitation("", "uinv_native")).rejects.toThrow("identity required");
  });
  it("requests a database password reset from Auth0 and does not handle social-provider passwords", async () => {
    const http = vi.fn<typeof fetch>().mockResolvedValue(new Response("email requested")), auth0 = provider(http);
    await auth0.requestPasswordReset("user@company.test", "auth0|user");
    expect(http).toHaveBeenCalledWith("https://identity.example.test/dbconnections/change_password", expect.objectContaining({ method: "POST", body: JSON.stringify({ client_id: "client", email: "user@company.test", connection: "Username-Password-Authentication" }), signal: expect.any(AbortSignal) }));
    const before = http.mock.calls.length; await expect(auth0.requestPasswordReset("user@company.test", "google-oauth2|user")).rejects.toThrow("sign-in provider"); expect(http).toHaveBeenCalledTimes(before);
    http.mockResolvedValue(new Response(null, { status: 503 })); await expect(auth0.requestPasswordReset("user@company.test", "auth0|user")).rejects.toThrow("503");
  });
  it("mirrors fresh/resend/cancel/expiry and verified callback context in the explicit mock provider", async () => {
    const mock = new MockIdentityProvider(), first = await mock.createOrganizationInvitation(input), next = await mock.createOrganizationInvitation(input);
    expect(first.id).not.toBe(next.id); expect(first.invitationUrl).not.toBe(next.invitationUrl);
    const ticket = new URL(first.invitationUrl).searchParams.get("invitation")!;
    expect(await mock.handleCallback({ code: "invite:" + ticket, redirectUri: "https://app.test", codeVerifier: "proof" })).toMatchObject({ email: input.email.toLowerCase(), emailVerified: true, organizationId: input.organizationId });
    await mock.revokeOrganizationInvitation(input.organizationId, first.id);
    await expect(mock.handleCallback({ code: "invite:" + ticket, redirectUri: "https://app.test", codeVerifier: "proof" })).rejects.toThrow("unavailable");
    const secondTicket = new URL(next.invitationUrl).searchParams.get("invitation")!;
    try { vi.useFakeTimers(); vi.setSystemTime(Date.now() + 604800001); await expect(mock.handleCallback({ code: "invite:" + secondTicket, redirectUri: "https://app.test", codeVerifier: "proof" })).rejects.toThrow("unavailable"); } finally { vi.useRealTimers(); }
    await mock.requestPasswordReset("user@company.test", "auth0|user"); expect(mock.passwordResetRequests).toEqual(["user@company.test"]);
  });
  it("refuses organization invitations and database password resets with the Google-only provider", async () => {
    const google = new GoogleIdentityProvider({ clientId: "client", clientSecretRef: "fixture", resolveSecret: async () => "fixture", fetchImpl: vi.fn<typeof fetch>() }, new InMemorySessionStore());
    await expect(google.createOrganizationInvitation(input)).rejects.toThrow("Auth0"); await expect(google.revokeOrganizationInvitation(input.organizationId, "id")).rejects.toThrow("Auth0");
    await expect(google.requestPasswordReset(input.email, "google|user")).rejects.toThrow("Google account");
  });
});
