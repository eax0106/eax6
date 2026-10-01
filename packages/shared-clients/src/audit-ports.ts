import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type {
  GetEventRequest,
  GetEventResponse,
  RecordEventRequest,
  RecordEventResponse,
} from "@alterx/contracts";
import type { BaseProvider, JsonValue } from "./provider-types";

export const AUDIT_GENESIS_HASH_HEX = "00".repeat(32);
export const AUDIT_EVENT_HANDLER = Symbol.for("@alterx/AuditEventHandler");
export const AUDIT_STORE_PROVIDER = Symbol.for("@alterx/AuditStoreProvider");

export type AuditActorType =
  | "user"
  | "service"
  | "admin"
  | "support"
  | "system";
export type AuditResult = "success" | "denied" | "error";

export interface AuditEventToAppend {
  readonly id: string;
  readonly tenantId: string | null;
  readonly tenantPseudonym: string | null;
  readonly actorType: AuditActorType;
  readonly actorRef: string;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetRef: string | null;
  readonly result: AuditResult;
  readonly reasonCode: string | null;
  readonly context: Readonly<Record<string, JsonValue>> | null;
  readonly occurredAt: Date;
}

export interface StoredAuditEvent extends Omit<AuditEventToAppend, "actorRef"> {
  readonly chainPosition?: number;
  readonly prevHash: Buffer;
  readonly entryHash: Buffer;
  /** Set when the event was minimised to a skeleton at tenant erasure (D2). Null otherwise. */
  readonly erasedAt: Date | null;
  /** Null on skeletons: the human identifier is destroyed at minimisation. */
  readonly actorRef: string | null;
}

export interface AuditEventQuery {
  // null = cross-tenant query (staff/admin use only, enforced by the caller,
  // not by the store itself -- the store applies whatever filter it's given).
  readonly tenantId: string | null;
  readonly actorTypes?: readonly AuditActorType[];
  readonly action?: string;
  readonly result?: AuditResult;
  readonly occurredAfter?: Date;
  readonly occurredBefore?: Date;
  readonly cursor?: string;
  readonly limit: number;
}

export interface AuditEventQueryResult {
  readonly events: readonly StoredAuditEvent[];
  readonly nextCursor: string | null;
}

export interface DeletionCertificateToStore {
  readonly id: string;
  readonly tenantPseudonym: string;
  readonly manifest: Readonly<Record<string, JsonValue>>;
  readonly requestedAt: Date;
  readonly completedAt: Date | null;
  readonly verifiedBy: string;
}

export interface DeletionLedgerEntry {
  readonly id: string;
  readonly subjectPseudonym: string;
  readonly subjectSelectors: Readonly<Record<string, JsonValue>>;
  readonly deletedAt: Date;
}

export type AuditChainVerificationIssue =
  | "broken-link"
  | "hash-mismatch"
  | "fork"
  | "orphan";

export interface AuditChainVerificationResult {
  readonly valid: boolean;
  readonly checkedEvents: number;
  readonly issue?: AuditChainVerificationIssue;
  readonly eventId?: string;
}

/**
 * ENGINE-FIX-P3-13: readGlobalChain() loads the whole audit_events table
 * into memory -- fine for an on-demand full re-verify, an OOM risk for a
 * scheduled job on a table that only grows. The checkpoint makes periodic
 * verification O(new entries): each run resumes from the last entryHash it
 * confirmed valid, instead of re-walking the full history every time.
 */
export interface AuditChainCheckpoint {
  readonly lastPosition?: number;
  readonly lastEntryHash: Buffer;
  readonly checkedEvents: number;
  readonly verifiedAt: Date;
  /** HMAC-SHA256 over the canonical checkpoint (Y2 compaction seal). Absent on legacy rows. */
  readonly signature?: Buffer | undefined;
}

/**
 * The compaction seal (D2, Y2): binds a checkpoint's hash, count and time
 * to the audit chain signing key, so a checkpoint that skips tampered
 * history cannot be forged without the key.
 */
export function canonicalAuditCheckpoint(checkpoint: {
  readonly lastPosition?: number;
  readonly lastEntryHash: Buffer;
  readonly checkedEvents: number;
  readonly verifiedAt: Date;
}): Buffer {
  return Buffer.from(
    serializeCanonical({
      checked_events: checkpoint.checkedEvents,
      ...(checkpoint.lastPosition === undefined ? {} : { last_position: checkpoint.lastPosition }),
      last_entry_hash: checkpoint.lastEntryHash.toString("hex"),
      verified_at: checkpoint.verifiedAt.toISOString(),
    }),
    "utf8",
  );
}

export function signAuditCheckpoint(
  signingKey: string,
  checkpoint: {
    readonly lastPosition?: number;
    readonly lastEntryHash: Buffer;
    readonly checkedEvents: number;
    readonly verifiedAt: Date;
  },
): Buffer {
  if (signingKey.length < 32) {
    throw new Error("Audit chain signing key must contain at least 32 characters");
  }
  return createHmac("sha256", signingKey).update(canonicalAuditCheckpoint(checkpoint)).digest();
}

export function verifyAuditCheckpointSignature(
  signingKey: string,
  checkpoint: {
    readonly lastPosition?: number;
    readonly lastEntryHash: Buffer;
    readonly checkedEvents: number;
    readonly verifiedAt: Date;
    readonly signature?: Buffer | undefined;
  },
): boolean {
  if (checkpoint.signature === undefined || checkpoint.signature.length !== 32) {
    return false;
  }
  return timingSafeEqual(checkpoint.signature, signAuditCheckpoint(signingKey, checkpoint));
}

export interface AuditStoreProvider extends BaseProvider<"AuditStoreProvider"> {
  migrate(): Promise<void>;
  append(event: AuditEventToAppend, seal?: AuditChainCheckpoint): Promise<StoredAuditEvent>;
  getById(id: string): Promise<StoredAuditEvent | undefined>;
  readGlobalChain(): Promise<readonly StoredAuditEvent[]>;
  /** Bounded forward walk from a checkpoint hash -- never the whole table. */
  readChainSince(
    afterEntryHash: Buffer,
    limit: number,
    afterPosition?: number,
  ): Promise<readonly StoredAuditEvent[]>;
  getChainCheckpoint(): Promise<AuditChainCheckpoint | undefined>;
  setChainCheckpoint(checkpoint: AuditChainCheckpoint): Promise<void>;
  /**
   * Minimise one tenant's events to skeletons at erasure: tenant linkage
   * becomes the pseudonym, content columns go NULL, erased_at is stamped.
   * Hashes and linkage stay byte-identical so sealed history keeps
   * verifying. Returns rows minimised. Idempotent.
   */
  minimiseTenantEvents(tenantId: string, pseudonym: string, erasedAt: Date, seal?: AuditChainCheckpoint): Promise<number>;
  /**
   * Destroy sealed skeletons past the window: minimised rows with erased_at
   * at or before the cutoff, excluding the anchor row and every row a
   * surviving row links to. Returns rows destroyed.
   */
  expireSkeletons(cutoff: Date, anchorHash: Buffer, anchorPosition?: number): Promise<number>;
  queryEvents(query: AuditEventQuery): Promise<AuditEventQueryResult>;
  storeDeletionCertificate(certificate: DeletionCertificateToStore): Promise<void>;
  appendDeletionLedger(entry: DeletionLedgerEntry): Promise<void>;
  storeDeletionCompletion(
    certificate: DeletionCertificateToStore,
    ledgerEntry: DeletionLedgerEntry,
  ): Promise<void>;
  listDeletionLedgerSince(since: Date): Promise<readonly DeletionLedgerEntry[]>;
  close(): Promise<void>;
}

export interface AuditEventHandler {
  recordEvent(request: RecordEventRequest): Promise<RecordEventResponse>;
  getEvent(request: GetEventRequest): Promise<GetEventResponse>;
}

export class AuditEventNotFoundError extends Error {
  constructor(eventId: string) {
    super(`Audit event was not found: ${eventId}`);
    this.name = "AuditEventNotFoundError";
  }
}

export class AuditValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditValidationError";
  }
}

function serializeCanonical(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Audit context cannot contain non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeCanonical(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serializeCanonical(object[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`Unsupported canonical audit value: ${typeof value}`);
}

export function auditGenesisHash(): Buffer {
  return Buffer.from(AUDIT_GENESIS_HASH_HEX, "hex");
}

export function canonicalAuditEvent(
  event: Omit<StoredAuditEvent, "entryHash">,
): Buffer {
  return Buffer.from(
    serializeCanonical({
      action: event.action,
      actor_ref: event.actorRef,
      actor_type: event.actorType,
      context: event.context,
      id: event.id,
      occurred_at: event.occurredAt.toISOString(),
      prev_hash: event.prevHash.toString("hex"),
      reason_code: event.reasonCode,
      result: event.result,
      target_ref: event.targetRef,
      target_type: event.targetType,
      tenant_id: event.tenantId,
      tenant_pseudonym: event.tenantPseudonym,
    }),
    "utf8",
  );
}

export function calculateAuditEntryHash(
  event: Omit<StoredAuditEvent, "entryHash">,
): Buffer {
  return createHash("sha256")
    .update(event.prevHash)
    .update(canonicalAuditEvent(event))
    .digest();
}

function hashKey(value: Buffer): string {
  return value.toString("hex");
}

export function verifyAuditChain(
  events: readonly StoredAuditEvent[],
  startingHash: Buffer = auditGenesisHash(),
): AuditChainVerificationResult {
  const byPreviousHash = new Map<string, StoredAuditEvent[]>();
  for (const event of events) {
    const key = hashKey(event.prevHash);
    const successors = byPreviousHash.get(key) ?? [];
    successors.push(event);
    byPreviousHash.set(key, successors);
  }

  let expectedPreviousHash: Buffer<ArrayBufferLike> = startingHash;
  const visited = new Set<string>();
  while (true) {
    const successors = byPreviousHash.get(hashKey(expectedPreviousHash)) ?? [];
    if (successors.length === 0) {
      break;
    }
    if (successors.length > 1) {
      return { valid: false, checkedEvents: visited.size, issue: "fork" };
    }

    const event = successors[0];
    if (event === undefined || visited.has(event.id)) {
      return {
        valid: false,
        checkedEvents: visited.size,
        issue: "broken-link",
        ...(event === undefined ? {} : { eventId: `aud_${event.id}` }),
      };
    }
    // Sealed rows are excluded by the trusted checkpoint before this walk.
    // A marker on a post-checkpoint row never exempts its content hash.
    if (!calculateAuditEntryHash(event).equals(event.entryHash)) {
      return {
        valid: false,
        checkedEvents: visited.size,
        issue: "hash-mismatch",
        eventId: `aud_${event.id}`,
      };
    }

    visited.add(event.id);
    expectedPreviousHash = event.entryHash;
  }

  if (visited.size !== events.length) {
    return { valid: false, checkedEvents: visited.size, issue: "orphan" };
  }
  return { valid: true, checkedEvents: visited.size };
}
