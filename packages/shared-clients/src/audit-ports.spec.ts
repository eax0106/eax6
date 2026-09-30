import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  AUDIT_GENESIS_HASH_HEX,
  calculateAuditEntryHash,
  signAuditChainCheckpoint,
  verifyAuditChainCheckpointSignature,
  verifyAuditChain,
  type AuditEventToAppend,
} from "./audit-ports";
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
      signature: signAuditChainCheckpoint(
        {
          lastEntryHash: stored.entryHash,
          checkedEvents: 1,
          signatureKeyId: "test-key",
        },
        "test-checkpoint-signing-secret",
      ),
      signatureKeyId: "test-key",
    });

    const checkpoint = await provider.getChainCheckpoint();
    expect(checkpoint?.lastEntryHash).toEqual(stored.entryHash);
    expect(checkpoint?.checkedEvents).toBe(1);
    expect(checkpoint?.verifiedAt).toEqual(verifiedAt);
    expect(checkpoint).toBeDefined();
    if (checkpoint !== undefined) {
      expect(
        verifyAuditChainCheckpointSignature(
          checkpoint,
          "test-checkpoint-signing-secret",
        ),
      ).toBe(true);
      expect(
        verifyAuditChainCheckpointSignature(checkpoint, "forged-secret"),
      ).toBe(false);
    }
  });

  it("compacts only rows sealed before a checkpoint", async () => {
    const provider = createMockAuditStoreProvider();
    const first = await provider.append(event("system-0"));
    const checkpoint = await provider.append(event("system-1"));
    const afterCheckpoint = await provider.append(event("system-2"));

    await expect(
      provider.compactAuditEventsBeforeCheckpoint(checkpoint.entryHash),
    ).resolves.toBe(1);

    expect(provider.snapshot().map((row) => row.id)).toEqual([
      checkpoint.id,
      afterCheckpoint.id,
    ]);
    expect(provider.snapshot()[0]?.id).not.toBe(first.id);
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
