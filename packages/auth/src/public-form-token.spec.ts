import { describe, expect, it } from "vitest";
import { PublicFormTokenCodec } from "./public-form-token";

const claims = { tenantId: "ten_01970000-0000-7000-8000-000000000001", triggerId: "trg_01970000-0000-7000-8000-000000000002", triggerVersionId: "trv_01970000-0000-7000-8000-000000000003" };
const codec = new PublicFormTokenCodec("37".repeat(32));
describe("version-bound public form capabilities", () => {
  it("roundtrips validated tenant/trigger/version, with randomized opaque links", () => {
    const first = codec.mint(claims), second = codec.mint(claims);
    expect(first).not.toEqual(second); expect(codec.parse(first)).toEqual(claims); expect(codec.parse(second)).toEqual(claims); expect(first).not.toContain(claims.tenantId);
  });
  it("rejects each modified encrypted byte and a different deployment key", () => {
    const token = codec.mint(claims), bytes = Buffer.from(token.slice(3), "base64url");
    for (let index = 0; index < bytes.length; index++) {
      const modified = Buffer.from(bytes); modified[index] = modified[index]! ^ 1;
      expect(codec.parse("f1_" + modified.toString("base64url"))).toBeNull();
    }
    expect(new PublicFormTokenCodec("45".repeat(32)).parse(token)).toBeNull();
  });
  it("rejects malformed tokens, invalid identities and missing/weak configuration", () => {
    const token = codec.mint(claims);
    for (const invalid of ["", token + "a", token.slice(0, -1), "f2_" + token.slice(3), "f1_" + "_".repeat(102)]) expect(codec.parse(invalid)).toBeNull();
    expect(() => codec.mint({ ...claims, tenantId: "ten_invalid" })).toThrow();
    for (const key of ["", "a".repeat(63), "x".repeat(64)]) expect(() => new PublicFormTokenCodec(key)).toThrow();
  });
});
