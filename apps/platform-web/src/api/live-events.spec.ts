import { afterEach, describe, expect, it, vi } from "vitest"
import { getEvent, replayEvent, replayEventForReal } from "./live"

afterEach(() => vi.unstubAllGlobals())
describe("live event replay adapter", () => {
  it("reads stored payload, defaults to dry replay, and sends only confirmation with a stable real request key", async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify(
      init?.method === "POST" ? { mode: "dry_run", trace: [], actions: [] } : { event_id: "evt/a", payload_inline: { stored: 1 } }),
    { status: 200, headers: { "content-type": "application/json" } }))
    vi.stubGlobal("fetch", fetcher)
    expect(await getEvent("evt/a")).toMatchObject({ id: "evt/a", payload: { stored: 1 } })
    await replayEvent("evt/a")
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/v1/events/evt%2Fa/replay")
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({})
    await replayEventForReal("evt/a", "a".repeat(64), "event-replay-stable-key")
    const [url, init] = fetcher.mock.calls[2]!
    expect(url).toBe("/api/v1/events/evt%2Fa/replay-for-real")
    expect(JSON.parse(String(init?.body))).toEqual({ confirmed: true, confirmationToken: "a".repeat(64) })
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("event-replay-stable-key")
  })
})
