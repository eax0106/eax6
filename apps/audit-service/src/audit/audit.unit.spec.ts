import type { RecordEventRequest } from "@alterx/contracts";
import {
  auditGenesisHash,
  calculateAuditEntryHash,
  canonicalAuditEvent,
  createMockAuditStoreProvider,
  type AuditEventToAppend,
  type AuditStoreProvider,
  type StoredAuditEvent,
} from "@alterx/shared-clients";
import { describe, expect, it, vi } from "vitest";

import { auditId, createUuidV7 } from "./audit-id";
import { AuditService } from "./audit.service";

const TENANT_ID = "ten_018f47a2-7b11-7b11-8a11-1234567890ab";

function request(
  overrides: Partial<RecordEventRequest> = {},
): RecordEventRequest {
  return {
    tenant_id: TENANT_ID,
    actor_type: "admin",
    actor_ref: "usr_018f47a2-7b11-7b11-8a11-1234567890ab",
    action: "policy.promote",
    target_type: "policy",
    target_ref: "pol_018f47a2-7b11-7b11-8a11-1234567890ab",
    result: "success",
    reason_code: "",
    context_json: '{"scope":"policy:write","request_id":"request-1"}',
    occurred_at: "2026-07-24T06:30:00.000Z",
    ...overrides,
  };
}

function storedEvent(
  id: string,
  prevHash: Buffer,
  overrides: Partial<AuditEventToAppend> = {},
): StoredAuditEvent {
  const pending = {
    id,
    tenantId: TENANT_ID.slice(4),
    tenantPseudonym: null,
    actorType: "admin",
    actorRef: "admin-1",
    action: "policy.promote",
    targetType: "policy",
    targetRef: "policy-1",
    result: "success",
    reasonCode: null,
    context: { request_id: "request-1" },
    occurredAt: new Date("2026-07-24T06:30:00.000Z"),
    ...overrides,
    prevHash,
  } satisfies Omit<StoredAuditEvent, "entryHash">;
  return { ...pending, entryHash: calculateAuditEntryHash(pending) };
}

function serviceWithStore(events: readonly StoredAuditEvent[] = []): {
  readonly service: AuditService;
  readonly append: ReturnType<typeof vi.fn>;
} {
  const base = createMockAuditStoreProvider();
  const append = vi.fn(async (event: AuditEventToAppend) =>
    storedEvent(event.id, auditGenesisHash(), event),
  );
  const store: AuditStoreProvider = {
    ...base,
    append,
    readGlobalChain: vi.fn(async () => events),
  };
  return { service: new AuditService(store), append };
}

describe("audit canonicalization and identifiers", () => {
  it("uses UUIDv7 identifiers with aud_ transport prefixes", () => {
    const uuid = createUuidV7(1_753_337_800_000);
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(auditId(uuid)).toBe(`aud_${uuid}`);
    expect(() => createUuidV7(-1)).toThrow(RangeError);
    expect(() => createUuidV7(Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
  });

  it("produces identical canonical bytes for differently ordered context keys", () => {
    const first = storedEvent(
      "018f47a2-7b11-7b11-8a11-1234567890ab",
      auditGenesisHash(),
      { context: { z: 1, nested: { b: true, a: ["x", null] } } },
    );
    const second = storedEvent(
      "018f47a2-7b11-7b11-8a11-1234567890ab",
      auditGenesisHash(),
      { context: { nested: { a: ["x", null], b: true }, z: 1 } },
    );
    expect(canonicalAuditEvent(first)).toEqual(canonicalAuditEvent(second));
    expect(first.entryHash).toEqual(second.entryHash);
  });

  it("rejects values that JSON cannot represent deterministically", () => {
    const event = {
      ...storedEvent(
        "018f47a2-7b11-7b11-8a11-1234567890ab",
        auditGenesisHash(),
      ),
      context: { score: Number.NaN },
    };
    expect(() => canonicalAuditEvent(event)).toThrow(/non-finite/);
    expect(() =>
      canonicalAuditEvent({
        ...event,
        context: { unsupported: undefined },
      } as unknown as StoredAuditEvent),
    ).toThrow(/Unsupported canonical audit value/);
  });
});

describe("AuditService request validation", () => {
  it("uses generated contract input and stores unprefixed tenant UUID", async () => {
    const { service, append } = serviceWithStore();
    await expect(service.recordEvent(request())).resolves.toMatchObject({
      id: expect.stringMatching(/^aud_/),
      entry_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        tenantId: TENANT_ID.slice(4),
        actorType: "admin",
        context: { scope: "policy:write", request_id: "request-1" },
      }),
    );
  });

  it("accepts Platform's bare tenant UUID contract", async () => {
    const { service, append } = serviceWithStore();
    const tenantId = "f0204070-2fd2-4bb7-a117-3222301822fe";
    await service.recordEvent(request({ tenant_id: tenantId }));
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId }),
    );
  });

  it("accepts system event with nullable tenant, target, context, reason", async () => {
    const { service, append } = serviceWithStore();
    await service.recordEvent(
      request({
        tenant_id: "",
        actor_type: "system",
        target_type: "",
        target_ref: "",
        context_json: "",
      }),
    );
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: null,
        targetType: null,
        targetRef: null,
        context: null,
      }),
    );
  });

  it("accepts structured scope metadata without content fields", async () => {
    const { service, append } = serviceWithStore();
    await service.recordEvent(
      request({
        context_json: JSON.stringify({
          scope: ["policy:read", { resource: "policy" }],
        }),
      }),
    );
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        context: { scope: ["policy:read", { resource: "policy" }] },
      }),
    );
  });

  it.each([
    ["missing actor", { actor_ref: "" }, /actor_ref is required/],
    ["unknown actor type", { actor_type: "customer" }, /actor_type is not supported/],
    ["unknown result", { result: "partial" }, /result is not supported/],
    ["invalid tenant", { tenant_id: "tenant-1" }, /Platform UUID or ten_ prefixed UUIDv7/],
    ["invalid JSON", { context_json: "{" }, /valid JSON/],
    ["non-object context", { context_json: "[]" }, /JSON object/],
    ["content context", { context_json: '{"nested":{"prompt":"no"}}' }, /not permitted/],
    ["invalid timestamp", { occurred_at: "yesterday" }, /ISO 8601/],
    ["impossible timestamp", { occurred_at: "2026-99-99T00:00:00Z" }, /valid timestamp/],
    ["unpaired target", { target_ref: "" }, /must either both be set/],
    ["support reason", { actor_type: "support", reason_code: "" }, /reason_code is required/],
    ["break-glass reason", { action: "support.access.grant", reason_code: "" }, /reason_code is required/],
  ])("rejects %s", async (_name, overrides, message) => {
    const { service, append } = serviceWithStore();
    await expect(
      service.recordEvent(request(overrides as Partial<RecordEventRequest>)),
    ).rejects.toThrow(message as RegExp);
    expect(append).not.toHaveBeenCalled();
  });

  it("rejects oversized text and context values", async () => {
    const { service } = serviceWithStore();
    await expect(
      service.recordEvent(request({ actor_ref: "x".repeat(513) })),
    ).rejects.toThrow(/exceeds 512 bytes/);
    await expect(
      service.recordEvent(
        request({ context_json: JSON.stringify({ scope: "x".repeat(8_193) }) }),
      ),
    ).rejects.toThrow(/exceeds 8192 bytes/);
  });
});

describe("AuditService chain verification", () => {
  it("accepts empty chain", async () => {
    await expect(serviceWithStore().service.verifyChain()).resolves.toEqual({
      valid: true,
      checkedEvents: 0,
    });
  });

  it("detects forks, orphan rows, and hash mismatches", async () => {
    const first = storedEvent(
      "018f47a2-7b11-7b11-8a11-1234567890a1",
      auditGenesisHash(),
    );
    const fork = storedEvent(
      "018f47a2-7b11-7b11-8a11-1234567890a2",
      auditGenesisHash(),
    );
    await expect(
      serviceWithStore([first, fork]).service.verifyChain(),
    ).resolves.toMatchObject({ valid: false, issue: "fork" });

    const orphan = storedEvent(
      "018f47a2-7b11-7b11-8a11-1234567890a3",
      Buffer.alloc(32, 1),
    );
    await expect(
      serviceWithStore([first, orphan]).service.verifyChain(),
    ).resolves.toMatchObject({ valid: false, issue: "orphan" });

    const corrupt = { ...first, context: { request_id: "changed" } };
    await expect(
      serviceWithStore([corrupt]).service.verifyChain(),
    ).resolves.toMatchObject({ valid: false, issue: "hash-mismatch" });
  });
});

describe("AuditService.verifyChainIncremental", () => {
  it("leaves historical rows to the full-chain verifier once they are checkpointed", async () => {
    const first = storedEvent(
      "018f47a2-7b11-7b11-8a11-1234567890b1",
      auditGenesisHash(),
    );
    const second = storedEvent(
      "018f47a2-7b11-7b11-8a11-1234567890b2",
      first.entryHash,
    );
    const corruptFirst = {
      ...first,
      context: { request_id: "tampered-after-checkpoint" },
    };
    const store: AuditStoreProvider = {
      ...createMockAuditStoreProvider(),
      readGlobalChain: vi.fn(async () => [corruptFirst, second]),
      readChainSince: vi.fn(async () => []),
      getChainCheckpoint: vi.fn(async () => ({
        lastEntryHash: second.entryHash,
        checkedEvents: 2,
        verifiedAt: new Date("2026-07-24T07:00:00.000Z"),
      })),
    };
    const service = new AuditService(store);

    await expect(service.verifyChainIncremental(500)).resolves.toEqual({
      valid: true,
      checkedEvents: 0,
    });
    await expect(service.verifyChain()).resolves.toMatchObject({
      valid: false,
      issue: "hash-mismatch",
    });
  });

  it("returns valid/0 with no checkpoint advance when there is nothing new", async () => {
    const store = createMockAuditStoreProvider();
    const service = new AuditService(store);
    await expect(service.verifyChainIncremental(500)).resolves.toEqual({
      valid: true,
      checkedEvents: 0,
    });
    await expect(store.getChainCheckpoint()).resolves.toBeUndefined();
  });

  it("verifies real appended events and advances the checkpoint to the last one", async () => {
    const store = createMockAuditStoreProvider();
    const service = new AuditService(store);
    const first = await store.append(auditEventInput("a1"));
    const second = await store.append(auditEventInput("a2"));

    await expect(service.verifyChainIncremental(500)).resolves.toEqual({
      valid: true,
      checkedEvents: 2,
    });
    const checkpoint = await store.getChainCheckpoint();
    expect(checkpoint?.lastEntryHash).toEqual(second.entryHash);
    expect(checkpoint?.checkedEvents).toBe(2);
    void first;
  });

  it("resumes from the checkpoint instead of re-walking already-verified events", async () => {
    const store = createMockAuditStoreProvider();
    const service = new AuditService(store);
    await store.append(auditEventInput("b1"));
    await expect(service.verifyChainIncremental(500)).resolves.toEqual({
      valid: true,
      checkedEvents: 1,
    });

    const second = await store.append(auditEventInput("b2"));
    await expect(service.verifyChainIncremental(500)).resolves.toEqual({
      valid: true,
      checkedEvents: 1, // only the new one, not a re-walk of the first
    });
    const checkpoint = await store.getChainCheckpoint();
    expect(checkpoint?.lastEntryHash).toEqual(second.entryHash);
    expect(checkpoint?.checkedEvents).toBe(2); // cumulative
  });

  it("does not advance the checkpoint when the new segment is broken", async () => {
    const first = storedEvent(
      "018f47a2-7b11-7b11-8a11-1234567890c1",
      auditGenesisHash(),
    );
    const corrupt = { ...first, context: { request_id: "tampered" } };
    let checkpoint: { lastEntryHash: Buffer; checkedEvents: number; verifiedAt: Date } | undefined;
    const store: AuditStoreProvider = {
      ...createMockAuditStoreProvider(),
      readChainSince: vi.fn(async () => [corrupt]),
      getChainCheckpoint: vi.fn(async () => checkpoint),
      setChainCheckpoint: vi.fn(async (next) => {
        checkpoint = next;
      }),
    };
    const service = new AuditService(store);

    await expect(service.verifyChainIncremental(500)).resolves.toMatchObject({
      valid: false,
      issue: "hash-mismatch",
    });
    expect(checkpoint).toBeUndefined();
    expect(store.setChainCheckpoint).not.toHaveBeenCalled();
  });
});

function auditEventInput(suffix: string): AuditEventToAppend {
  return {
    id: `018f47a2-7b11-7b11-8a11-${suffix.padStart(12, "0")}`,
    tenantId: TENANT_ID.slice(4),
    tenantPseudonym: null,
    actorType: "admin",
    actorRef: "admin-1",
    action: "policy.promote",
    targetType: "policy",
    targetRef: "policy-1",
    result: "success",
    reasonCode: null,
    context: { request_id: "request-1" },
    occurredAt: new Date("2026-07-24T06:30:00.000Z"),
  };
}
