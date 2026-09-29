import { createPublicKey, createSign, createVerify } from "node:crypto";
import type { SystemActorTokenClaims } from "@alterx/contracts";
import type { ActorTokenClaims } from "./actor-token.types";

const algorithm = "RS256";
export const actorTokenKeyId = "actor-token-key-1";

export function signActorToken(
  claims: ActorTokenClaims | SystemActorTokenClaims,
  privateKey: string,
): string {
  const header = { alg: algorithm, typ: "JWT", kid: actorTokenKeyId };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey);

  return `${signingInput}.${signature.toString("base64url")}`;
}

export function actorTokenJwk(publicKey: string): Record<string, unknown> {
  const jwk = createPublicKey(publicKey).export({ format: "jwk" });
  return { ...jwk, kid: actorTokenKeyId, use: "sig", alg: algorithm };
}

export function decodeActorToken(token: string): ActorTokenClaims {
  const [, payload] = token.split(".");
  if (!payload) {
    throw new Error("Invalid actor token");
  }

  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ActorTokenClaims;
}

export function verifyActorToken(token: string, publicKey: string): boolean {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) {
    return false;
  }

  return createVerify("RSA-SHA256")
    .update(`${header}.${payload}`)
    .verify(publicKey, Buffer.from(signature, "base64url"));
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
