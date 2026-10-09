const http = require("node:http");
const crypto = require("node:crypto");

const PORT = Number(process.env.MOCK_AUTH0_PORT || 4999);
const ISSUER_DOMAIN = "alterx-local-m2m.test";
const ISSUER = `https://${ISSUER_DOMAIN}/`;
const KID = "local-m2m-key-1";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function signToken({ audience, tenantId, payloadWorkspaceId }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", kid: KID };
  const claims = {
    iss: ISSUER,
    aud: [audience, "https://audit-service.alterx.local", "https://internal.alter.local", "https://engine.alter.local"].filter(Boolean),
    iat: now,
    exp: now + 3600,
    tenant_id: tenantId || "ten_00000000-0000-7000-8000-000000000000",
    workspace_id: payloadWorkspaceId || "wrk_00000000-0000-7000-8000-000000000000",
    roles: ["admin"],
    permissions: ["runs:read", "runs:write", "credential:write"],
    "https://alter.dev/claims/actor_type": "service",
    "https://alter.local/roles": ["admin"],
    "https://alter.local/permissions": ["runs:read", "runs:write", "credential:write"]
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKey);
  return `${signingInput}.${base64url(signature).replace(/=+$/, "")}`;
}

const jwk = publicKey.export({ format: "jwk" });

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");

    if (req.url === "/.well-known/jwks.json") {
      res.end(JSON.stringify({ keys: [{ ...jwk, kid: KID, use: "sig", alg: "RS256" }] }));
      return;
    }

    if (req.url === "/oauth/token" && req.method === "POST") {
      let payload = {};
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        // fall through with empty payload
      }
      const token = signToken({ audience: payload.audience, tenantId: payload.tenantId || payload.organization, payloadWorkspaceId: payload.workspaceId });
      res.end(JSON.stringify({ access_token: token, expires_in: 3600, token_type: "Bearer" }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not_found" }));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock M2M server listening on http://127.0.0.1:${PORT}`);
});
