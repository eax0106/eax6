import { Metadata, status } from "@grpc/grpc-js";
import { describe, expect, it, vi } from "vitest";

import { AdsQueryClient, AdsQueryClientError } from "./adsq-client";

const request = { tenant_id: "ten_1", workspace_id: "ws_1", query: "refunds", top_k: 3, requester: "tool-gateway" };
const hit = { document_id: "doc_1", chunk_reference: "c1", score: 0.9, confidence: 0.9, provenance_json: "{}", context: "Refunds take 5 days." };

describe("AdsQueryClient", () => {
  it("sends the scoped query with the service credential and returns hits with their text", async () => {
    const Retrieve = vi.fn((_request: unknown, metadata: Metadata, _options: unknown, done: (error: Error | null, response?: unknown) => void) => {
      expect(metadata.get("authorization")).toEqual(["Bearer token"]);
      done(null, { hits: [hit] });
    });
    const ads = new AdsQueryClient({ address: "x", protoPath: "unused", authorization: "Bearer token" }, { Retrieve } as never);
    await expect(ads.retrieve(request)).resolves.toEqual([hit]);
    expect(Retrieve.mock.calls[0]![0]).toEqual({ ...request, scope_ids: [], metadata_filter_json: "{}" });
  });

  it("names the failure class without the upstream body", async () => {
    for (const [code, name] of [[status.PERMISSION_DENIED, "permission_denied"], [status.INVALID_ARGUMENT, "invalid_argument"],
      [status.DEADLINE_EXCEEDED, "deadline_exceeded"], [status.UNAVAILABLE, "upstream"]] as const) {
      const Retrieve = vi.fn((_r: unknown, _m: unknown, _o: unknown, done: (error: Error | null) => void) => done(Object.assign(new Error("secret detail"), { code })));
      const ads = new AdsQueryClient({ address: "x", protoPath: "unused", authorization: "Bearer t" }, { Retrieve } as never);
      const error = await ads.retrieve(request).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AdsQueryClientError);
      expect((error as AdsQueryClientError).code).toBe(name);
      expect((error as Error).message).not.toContain("secret detail");
    }
  });
});
