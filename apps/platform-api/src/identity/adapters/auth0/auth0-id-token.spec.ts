import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemorySessionStore } from "../../session-store";
import { InMemorySsoConfigStore } from "../../sso-config-store";
import { Auth0IdentityProvider } from "./auth0-identity-provider";

const request = { code: "provider-code", redirectUri: "https://app.test/auth/callback", codeVerifier: "pkce-proof" };
function fixture(patch: Record<string, unknown> = {}, options: { missing?: boolean; badSignature?: boolean; profileOrg?: string; unverified?: boolean; profile?: Record<string, unknown> } = {}) {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 }), now = Math.floor(Date.now() / 1000);
  const claims = { iss: "https://tenant.auth0.test/", aud: "client-id", sub: "auth0|invited", iat: now, exp: now + 60, org_id: "org_native", ...patch };
  const head = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "id-native" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url"), signed = head + "." + payload;
  const signer = options.badSignature ? generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey : pair.privateKey;
  const token = signed + "." + createSign("RSA-SHA256").update(signed).sign(signer).toString("base64url");
  const fetchImpl: typeof fetch = async input => {
    const url = input.toString();
    if (url.endsWith("/oauth/token")) return Response.json({ access_token: "controlled-access", ...(options.missing ? {} : { id_token: token }) });
    if (url.endsWith("/userinfo")) return Response.json({ sub: "auth0|invited", email: "invited@company.test", email_verified: !options.unverified, ...(options.profileOrg ? { org_id: options.profileOrg } : {}), ...options.profile });
    if (url.endsWith("/.well-known/jwks.json")) return Response.json({ keys: [{ ...pair.publicKey.export({ format: "jwk" }), kid: "id-native", alg: "RS256", use: "sig" }] });
    return new Response("unknown fixture endpoint", { status: 404 });
  };
  return new Auth0IdentityProvider({ domain: "tenant.auth0.test", clientId: "client-id", fetchImpl }, new InMemorySessionStore(), new InMemorySsoConfigStore());
}

describe("Auth0 callback ID-token organization authority", () => {
  it("verifies signed organization token when standard UserInfo has no organization claim", async () => {
    expect(await fixture().handleCallback(request)).toMatchObject({ identityRef: "auth0|invited", email: "invited@company.test", emailVerified: true, organizationId: "org_native" });
    expect(await fixture({ org_id: undefined }).handleCallback(request)).not.toHaveProperty("organizationId");
    expect(await fixture({ aud: ["client-id", "other"], azp: "client-id" }).handleCallback(request)).toMatchObject({ organizationId: "org_native" });
    expect(await fixture({}, { unverified: true }).handleCallback(request)).toMatchObject({ emailVerified: false });
  });
  it("refuses malformed provider profile fields before returning an identity", async () => {
    for (const profile of [{ email: "not-email" }, { email: "x".repeat(321) + "@company.test" }, { email_verified: "true" }, { name: "x".repeat(301) }, { "https://alter.dev/user_id": 7 }]) {
      await expect(fixture({}, { profile }).handleCallback(request)).rejects.toThrow();
    }
  });
  it("rejects missing, tampered, expired, wrong issuer/audience/subject/authorized party and malformed organization", async () => {
    for (const provider of [fixture({}, { missing: true }), fixture({}, { badSignature: true }), fixture({ exp: 1 }), fixture({ iss: "https://other.auth0.test/" }), fixture({ aud: "other-client" }), fixture({ sub: "auth0|other" }), fixture({ azp: "other-client" }), fixture({ aud: ["client-id", "other"] }), fixture({ org_id: "" }), fixture({ org_id: 42 }), fixture({ org_id: "x".repeat(51) }), fixture({}, { profileOrg: "org_other" })]) {
      await expect(provider.handleCallback(request)).rejects.toThrow();
    }
  });
});
