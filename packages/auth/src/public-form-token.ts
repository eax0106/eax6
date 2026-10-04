import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { PublicFormTokenClaimsSchema, type PublicFormTokenClaims } from "@alterx/contracts";

const context = Buffer.from("alter.public-form.v1");
function uuid(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** An encrypted capability for one version; database state remains authoritative. */
export class PublicFormTokenCodec {
  private readonly key: Buffer;
  constructor(keyHex: string) {
    if (!/^[a-f0-9]{64}$/i.test(keyHex)) throw new Error("Public form token key must be 32 bytes encoded as hex");
    this.key = Buffer.from(keyHex, "hex");
  }
  mint(input: PublicFormTokenClaims): string {
    const claims = PublicFormTokenClaimsSchema.parse(input);
    const payload = Buffer.concat([claims.tenantId, claims.triggerId, claims.triggerVersionId].map(id => Buffer.from(id.slice(4).replaceAll("-", ""), "hex")));
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(context);
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    return "f1_" + Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString("base64url");
  }
  parse(token: string): PublicFormTokenClaims | null {
    if (!/^f1_[A-Za-z0-9_-]{102}$/.test(token)) return null;
    try {
      const data = Buffer.from(token.slice(3), "base64url");
      if (data.length !== 76 || data.toString("base64url") !== token.slice(3)) return null;
      const decipher = createDecipheriv("aes-256-gcm", this.key, data.subarray(0, 12));
      decipher.setAAD(context); decipher.setAuthTag(data.subarray(60));
      const plain = Buffer.concat([decipher.update(data.subarray(12, 60)), decipher.final()]);
      const claims = PublicFormTokenClaimsSchema.safeParse({
        tenantId: "ten_" + uuid(plain.subarray(0, 16)), triggerId: "trg_" + uuid(plain.subarray(16, 32)), triggerVersionId: "trv_" + uuid(plain.subarray(32, 48)),
      });
      return claims.success ? claims.data : null;
    } catch { return null; }
  }
}
