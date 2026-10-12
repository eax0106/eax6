import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  AUDIT_GENESIS_HASH_HEX,
  AuditValidationError,
  calculateAuditEntryHash,
  parseAuditContext,
  verifyAuditChain,
  type AuditEventToAppend,
} from "./audit-ports";
import { createMockAuditEventHandler } from "./mocks/audit-event-handler";
import { createMockAuditStoreProvider } from "./mocks/audit-store-provider";

function event(actorRef: string): AuditEventToAppend {
  return {
    id: randomUUID(),
    tenantId: null,
    tenantPseudonym: null,
    actorType: "system",
    actorRef,
    action: "system.test",
    targetType: null,
    targetRef: null,
    result: "success",
    reasonCode: null,
    context: { request_id: actorRef },
    occurredAt: new Date("2026-07-24T06:30:00.000Z"),
  };
}

describe("AuditStoreProvider mock", () => {
  it("serializes concurrent appends into a verifiable global chain", async () => {
    const provider = createMockAuditStoreProvider();
    const stored = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        provider.append(event(`system-${index}`)),
      ),
    );

    expect(stored[0]?.prevHash.toString("hex")).toBe(
      AUDIT_GENESIS_HASH_HEX,
    );
    expect(calculateAuditEntryHash(stored[0]!)).toEqual(stored[0]?.entryHash);
    expect(verifyAuditChain(await provider.readGlobalChain())).toEqual({
      valid: true,
      checkedEvents: 8,
    });
    expect(provider.snapshot()).toHaveLength(8);
  });

  it("readChainSince resumes from a checkpoint hash instead of the whole table", async () => {
    const provider = createMockAuditStoreProvider();
    const first = await provider.append(event("system-0"));
    const second = await provider.append(event("system-1"));
    const third = await provider.append(event("system-2"));

    const fromGenesis = await provider.readChainSince(
      Buffer.from(AUDIT_GENESIS_HASH_HEX, "hex"),
      10,
    );
    expect(fromGenesis.map((e) => e.id)).toEqual([first.id, second.id, third.id]);

    const fromFirst = await provider.readChainSince(first.entryHash, 10);
    expect(fromFirst.map((e) => e.id)).toEqual([second.id, third.id]);

    const fromFirstBounded = await provider.readChainSince(first.entryHash, 1);
    expect(fromFirstBounded.map((e) => e.id)).toEqual([second.id]);

    // verifyAuditChain's startingHash param verifies just that segment,
    // treating first.entryHash as the known-good starting point rather
    // than always re-deriving from genesis.
    expect(verifyAuditChain(fromFirst, first.entryHash)).toEqual({
      valid: true,
      checkedEvents: 2,
    });
  });

  it("persists and reads back a chain checkpoint", async () => {
    const provider = createMockAuditStoreProvider();
    await expect(provider.getChainCheckpoint()).resolves.toBeUndefined();

    const stored = await provider.append(event("system-checkpoint"));
    const verifiedAt = new Date("2026-08-01T00:00:00.000Z");
    await provider.setChainCheckpoint({
      lastEntryHash: stored.entryHash,
      checkedEvents: 1,
      verifiedAt,
    });

    const checkpoint = await provider.getChainCheckpoint();
    expect(checkpoint?.lastEntryHash).toEqual(stored.entryHash);
    expect(checkpoint?.checkedEvents).toBe(1);
    expect(checkpoint?.verifiedAt).toEqual(verifiedAt);
  });

  it("returns defensive copies and supports lifecycle methods", async () => {
    const provider = createMockAuditStoreProvider();
    const stored = await provider.append(event("system-copy"));
    stored.prevHash.fill(1);

    expect(provider.snapshot()[0]?.prevHash.toString("hex")).toBe(
      AUDIT_GENESIS_HASH_HEX,
    );
    await expect(provider.migrate()).resolves.toBeUndefined();
    await expect(provider.close()).resolves.toBeUndefined();
  });
});

describe("audit context rules", () => {
  it("keeps the service's top-level allowlist and nested forbidden keys", () => {
    expect(parseAuditContext("")).toBeNull();
    expect(parseAuditContext(JSON.stringify({ scope: { before: { contains_pii: false } }, request_id: "r" })))
      .toEqual({ scope: { before: { contains_pii: false } }, request_id: "r" });
    expect(() => parseAuditContext(JSON.stringify({ deletion_due_at: "2026-10-19T00:00:00.000Z" })))
      .toThrow(new AuditValidationError("context.deletion_due_at is not permitted"));
    expect(() => parseAuditContext(JSON.stringify({ scope: { secret_ref: "x" } }))).toThrow(AuditValidationError);
    expect(() => parseAuditContext("[]")).toThrow(AuditValidationError);
  });

  it("makes the shared mock refuse what the audit service refuses", async () => {
    const handler = createMockAuditEventHandler();
    const request = { tenant_id: "ten_x", actor_type: "user", actor_ref: "usr_x", action: "workspace.deletion.request",
      target_type: "workspace", target_ref: "ws_x", result: "success", reason_code: "", occurred_at: new Date().toISOString() };
    await expect(handler.recordEvent({ ...request, context_json: JSON.stringify({ deletion_due_at: "later" }) }))
      .rejects.toThrow(AuditValidationError);
    expect(handler.getRecordedEvents()).toEqual([]);
    await expect(handler.recordEvent({ ...request, context_json: JSON.stringify({ scope: { deletion_due_at: "later" } }) }))
      .resolves.toMatchObject({ id: expect.any(String) });
  });
});
