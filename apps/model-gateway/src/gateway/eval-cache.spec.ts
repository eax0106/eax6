import { createMockCacheProvider } from "@alterx/shared-clients";
import { describe, expect, it } from "vitest";
import { evalCacheProvider } from "./eval-cache";

describe("evalCacheProvider (C17: the eval harness bypasses the cache)", () => {
  it("never returns a stored value", async () => {
    const provider = evalCacheProvider(createMockCacheProvider());

    await provider.setValue("modelgw:exact:ten_x:abc", "{\"output_json\":\"{}\"}", 60);

    expect(await provider.getValue("modelgw:exact:ten_x:abc")).toBeUndefined();
  });
});
