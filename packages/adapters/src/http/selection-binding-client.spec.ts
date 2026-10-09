import { afterEach, describe, expect, it, vi } from "vitest";

import { createFetchSelectionBindingHttpClient } from "./selection-binding-client";

const URL = "http://intelligence.internal/selection-binding/bind-agent-model-tool";

function stubFetch(status: number, body: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status, headers: { "content-type": "application/json" } })),
  );
}

describe("createFetchSelectionBindingHttpClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("names the service's failure detail when a bind fails", async () => {
    stubFetch(502, JSON.stringify({ detail: "Model Gateway returned invalid agent instructions: bad" }));
    const client = createFetchSelectionBindingHttpClient(() => "token");

    await expect(client.postJson(URL, {})).rejects.toThrow(
      `Selection & Binding request to ${URL} failed with status 502: Model Gateway returned invalid agent instructions: bad`,
    );
  });

  it("bounds a long detail and still fails when the body is not JSON", async () => {
    stubFetch(502, JSON.stringify({ detail: "x".repeat(1000) }));
    const client = createFetchSelectionBindingHttpClient(() => "token");
    await expect(client.postJson(URL, {})).rejects.toThrow(/status 502: x{300}\.\.\.$/);

    stubFetch(503, "upstream down");
    await expect(client.postJson(URL, {})).rejects.toThrow(
      `Selection & Binding request to ${URL} failed with status 503`,
    );
  });
});
