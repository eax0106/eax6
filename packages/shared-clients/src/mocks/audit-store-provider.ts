import type { ProviderCapabilities } from "@alterx/contracts";
import { createMockProvider } from "../mock-provider";
import {
  auditGenesisHash,
  calculateAuditEntryHash,
  type AuditChainCheckpoint,
  type AuditEventQuery,
  type AuditEventQueryResult,
  type AuditEventToAppend,
  type AuditStoreProvider,
  type DeletionCertificateToStore,
  type DeletionLedgerEntry,
  type StoredAuditEvent,
} from "../audit-ports";
import type { ProviderMetadata } from "../provider-types";
import { mockCapabilities, mockMetadata } from "./shared";

export const MOCK_AUDIT_STORE_CAPABILITIES: ProviderCapabilities =
  mockCapabilities(8_192);

export interface MockAuditStoreProvider extends AuditStoreProvider {
  snapshot(): readonly StoredAuditEvent[];
  deletionCertificates(): readonly DeletionCertificateToStore[];
  deletionLedger(): readonly DeletionLedgerEntry[];
}

export interface MockAuditStoreProviderOptions {
  readonly providerId?: string;
  readonly metadata?: ProviderMetadata<"AuditStoreProvider">;
  readonly capabilities?: ProviderCapabilities;
}

function cloneEvent(event: StoredAuditEvent): StoredAuditEvent {
  return {
    ...event,
    context: event.context === null ? null : structuredClone(event.context),
    occurredAt: new Date(event.occurredAt),
    prevHash: Buffer.from(event.prevHash),
    entryHash: Buffer.from(event.entryHash),
  };
}

export function createMockAuditStoreProvider(
  options: MockAuditStoreProviderOptions = {},
): MockAuditStoreProvider {
  const providerId = options.providerId ?? "mock.audit-store";
  const events: StoredAuditEvent[] = [];
  const certificates: DeletionCertificateToStore[] = [];
  const ledger: DeletionLedgerEntry[] = [];
  let appendBarrier: Promise<void> = Promise.resolve();
  let checkpoint: AuditChainCheckpoint | undefined;

  const append = async (event: AuditEventToAppend): Promise<StoredAuditEvent> => {
    let stored: StoredAuditEvent | undefined;
    const operation = appendBarrier.then(() => {
      const prevHash = events.at(-1)?.entryHash ?? auditGenesisHash();
      const pending = { ...event, prevHash };
      stored = { ...pending, entryHash: calculateAuditEntryHash(pending) };
      events.push(stored);
    });
    appendBarrier = operation.catch(() => undefined);
    await operation;
    if (stored === undefined) {
      throw new Error("Mock audit append produced no event");
    }
    return cloneEvent(stored);
  };

  return createMockProvider<MockAuditStoreProvider>({
    metadata:
      options.metadata ?? mockMetadata(providerId, "AuditStoreProvider"),
    capabilities: options.capabilities ?? MOCK_AUDIT_STORE_CAPABILITIES,
    implementation: {
      migrate: async () => undefined,
      append,
      getById: async (id) => {
        const found = events.find((event) => event.id === id);
        return found === undefined ? undefined : cloneEvent(found);
      },
      readGlobalChain: async () => events.map(cloneEvent),
      readChainSince: async (afterEntryHash, limit) => {
        const afterHex = afterEntryHash.toString("hex");
        let startIndex: number;
        if (afterHex === auditGenesisHash().toString("hex")) {
          startIndex = 0;
        } else {
          const foundIndex = events.findIndex((event) => event.entryHash.toString("hex") === afterHex);
          if (foundIndex === -1) return [];
          startIndex = foundIndex + 1;
        }
        return events.slice(startIndex, startIndex + limit).map(cloneEvent);
      },
      getChainCheckpoint: async () =>
        checkpoint === undefined
          ? undefined
          : {
              lastEntryHash: Buffer.from(checkpoint.lastEntryHash),
              checkedEvents: checkpoint.checkedEvents,
              verifiedAt: new Date(checkpoint.verifiedAt),
              signature: Buffer.from(checkpoint.signature),
              signatureKeyId: checkpoint.signatureKeyId,
            },
      setChainCheckpoint: async (next) => {
        checkpoint = {
          lastEntryHash: Buffer.from(next.lastEntryHash),
          checkedEvents: next.checkedEvents,
          verifiedAt: new Date(next.verifiedAt),
          signature: Buffer.from(next.signature),
          signatureKeyId: next.signatureKeyId,
        };
      },
      compactAuditEventsBeforeCheckpoint: async (checkpointHash) => {
        const checkpointIndex = events.findIndex((event) =>
          event.entryHash.equals(checkpointHash),
        );
        if (checkpointIndex <= 0) return 0;
        return events.splice(0, checkpointIndex).length;
      },
      queryEvents: async (query: AuditEventQuery): Promise<AuditEventQueryResult> => {
        const filtered = events
          .filter((event) => query.tenantId === null || event.tenantId === query.tenantId)
          .filter((event) => query.actorTypes === undefined || query.actorTypes.includes(event.actorType))
          .filter((event) => query.action === undefined || event.action === query.action)
          .filter((event) => query.result === undefined || event.result === query.result)
          .filter((event) => query.occurredAfter === undefined || event.occurredAt >= query.occurredAfter)
          .filter((event) => query.occurredBefore === undefined || event.occurredAt <= query.occurredBefore)
          .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id));
        const startIndex = query.cursor === undefined
          ? 0
          : filtered.findIndex((event) => event.id === query.cursor) + 1;
        const page = filtered.slice(startIndex, startIndex + query.limit);
        const nextCursor = startIndex + query.limit < filtered.length
          ? (page.at(-1)?.id ?? null)
          : null;
        return { events: page.map(cloneEvent), nextCursor };
      },
      storeDeletionCertificate: async (certificate) => {
        certificates.push(structuredClone(certificate));
      },
      appendDeletionLedger: async (entry) => {
        ledger.push(structuredClone(entry));
      },
      storeDeletionCompletion: async (certificate, entry) => {
        certificates.push(structuredClone(certificate));
        ledger.push(structuredClone(entry));
      },
      listDeletionLedgerSince: async (since) =>
        ledger.filter((entry) => entry.deletedAt >= since).map((entry) => structuredClone(entry)),
      close: async () => undefined,
      snapshot: () => events.map(cloneEvent),
      deletionCertificates: () => certificates.map((entry) => structuredClone(entry)),
      deletionLedger: () => ledger.map((entry) => structuredClone(entry)),
    },
  });
}
