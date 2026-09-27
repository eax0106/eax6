import { describe, expect, it } from "vitest";
import { parseBindRepository, parseConnectionQuery, parseRepositoryId } from "./validation";

const instance = "/api/v1/repositories";

describe("repository validation", () => {
  it("accepts a GitHub owner/name and a connection id", () => {
    expect(
      parseBindRepository({ connection_id: "00000000-0000-7000-8000-0000000000c1", full_name: "alterx/engine.v2" }, instance),
    ).toEqual({ connection_id: "00000000-0000-7000-8000-0000000000c1", full_name: "alterx/engine.v2" });
  });

  it.each([
    [{ connection_id: "not-a-uuid", full_name: "a/b" }],
    [{ connection_id: "00000000-0000-7000-8000-0000000000c1", full_name: "../../etc" }],
    [{ connection_id: "00000000-0000-7000-8000-0000000000c1", full_name: "a/b", extra: 1 }],
    [{ connection_id: "00000000-0000-7000-8000-0000000000c1", full_name: "a/b/c" }],
  ])("rejects %j", (body) => {
    expect(() => parseBindRepository(body, instance)).toThrow();
  });

  it("rejects ids that are not repository ids", () => {
    expect(() => parseRepositoryId("prj_00000000-0000-7000-8000-000000000001", instance)).toThrow();
    expect(() => parseConnectionQuery(undefined, instance)).toThrow();
  });
});
