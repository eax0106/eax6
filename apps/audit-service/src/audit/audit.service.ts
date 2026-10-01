import { Inject, Injectable, Optional } from "@nestjs/common";

import type {
  GetEventRequest,
  GetEventResponse,
  RecordEventRequest,
  RecordEventResponse,
} from "@alterx/contracts";
import {
  AUDIT_STORE_PROVIDER,
  auditGenesisHash,
  AuditEventNotFoundError,
  AuditValidationError,
  signAuditCheckpoint,
  verifyAuditChain,
  verifyAuditCheckpointSignature,
  type AuditActorType,
  type AuditChainCheckpoint,
  type AuditChainVerificationResult,
  type AuditEventHandler,
  type AuditEventQuery,
  type AuditResult,
  type AuditStoreProvider,
  type JsonValue,
} from "@alterx/shared-clients";

import { auditId, createUuidV7 } from "./audit-id";
import {
  ACTOR_TYPES,
  AUDIT_RESULTS,
  type ValidatedAuditEvent,
} from "./audit.types";

const PREFIXED_TENANT_ID_PATTERN =
  /^ten_([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const PLATFORM_TENANT_ID_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const ISO_8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const FORBIDDEN_CONTEXT_KEYS = new Set([
  "body",
  "content",
  "conversation",
  "credential",
  "file",
  "input",
  "message",
  "output",
  "password",
  "payload",
  "prompt",
  "secret",
  "token",
]);
const ALLOWED_CONTEXT_KEYS = new Set(["ip_class", "request_id", "scope"]);
const MAX_CONTEXT_BYTES = 8_192;
const MAX_TEXT_LENGTH = 512;

/** Injection token for the audit chain signing key (Y2 compaction seals). Optional: absent outside the service. */
export const AUDIT_CHAIN_SIGNING_KEY = Symbol("AUDIT_CHAIN_SIGNING_KEY");

/** D2 skeleton window: sealed skeletons older than this are destroyed. */
const SKELETON_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** Bounded verification segment per compaction pass (same bound as the verify route). */
const MAX_COMPACT_VERIFY_LIMIT = 5_000;

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new AuditValidationError(`${field} is required`);
  }
  if (Buffer.byteLength(normalized, "utf8") > MAX_TEXT_LENGTH) {
    throw new AuditValidationError(`${field} exceeds ${MAX_TEXT_LENGTH} bytes`);
  }
  return normalized;
}

function optionalText(value: string, field: string): string | null {
  return value.trim().length === 0 ? null : requiredText(value, field);
}

function parseTenantId(value: string): string | null {
  if (value.trim().length === 0) {
    return null;
  }
  const normalized = value.trim();
  const match =
    PREFIXED_TENANT_ID_PATTERN.exec(normalized) ??
    PLATFORM_TENANT_ID_PATTERN.exec(normalized);
  if (match?.[1] === undefined) {
    throw new AuditValidationError(
      "tenant_id must be a Platform UUID or ten_ prefixed UUIDv7",
    );
  }
  return match[1];
}

function assertContextKeys(value: unknown, path = "context"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertContextKeys(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replaceAll(/[_-]/g, "");
    if (
      [...FORBIDDEN_CONTEXT_KEYS].some((forbidden) =>
        normalizedKey.includes(forbidden),
      )
    ) {
      throw new AuditValidationError(`${path}.${key} is not permitted`);
    }
    assertContextKeys(nested, `${path}.${key}`);
  }
}

function parseContext(value: string): Readonly<Record<string, JsonValue>> | null {
  if (value.trim().length === 0) {
    return null;
  }
  if (Buffer.byteLength(value, "utf8") > MAX_CONTEXT_BYTES) {
    throw new AuditValidationError(
      `context_json exceeds ${MAX_CONTEXT_BYTES} bytes`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new AuditValidationError("context_json must contain valid JSON");
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new AuditValidationError("context_json must contain a JSON object");
  }
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_CONTEXT_KEYS.has(key)) {
      throw new AuditValidationError(`context.${key} is not permitted`);
    }
  }
  assertContextKeys(parsed);
  return parsed as Readonly<Record<string, JsonValue>>;
}

function parseOccurredAt(value: string): Date {
  if (!ISO_8601_PATTERN.test(value)) {
    throw new AuditValidationError("occurred_at must be an ISO 8601 timestamp");
  }
  const occurredAt = new Date(value);
  if (Number.isNaN(occurredAt.getTime())) {
    throw new AuditValidationError("occurred_at must be a valid timestamp");
  }
  return occurredAt;
}

function requiresReasonCode(actorType: AuditActorType, action: string): boolean {
  const normalizedAction = action.toLowerCase();
  return (
    actorType === "support" ||
    normalizedAction.startsWith("support.access") ||
    normalizedAction.includes("break_glass") ||
    normalizedAction.includes("break-glass")
  );
}

function validateRequest(request: RecordEventRequest): ValidatedAuditEvent {
  const actorType = requiredText(request.actor_type, "actor_type");
  if (!ACTOR_TYPES.includes(actorType as AuditActorType)) {
    throw new AuditValidationError("actor_type is not supported");
  }
  const result = requiredText(request.result, "result");
  if (!AUDIT_RESULTS.includes(result as AuditResult)) {
    throw new AuditValidationError("result is not supported");
  }

  const targetType = optionalText(request.target_type, "target_type");
  const targetRef = optionalText(request.target_ref, "target_ref");
  if ((targetType === null) !== (targetRef === null)) {
    throw new AuditValidationError(
      "target_type and target_ref must either both be set or both be empty",
    );
  }

  const action = requiredText(request.action, "action");
  const reasonCode = optionalText(request.reason_code, "reason_code");
  if (
    requiresReasonCode(actorType as AuditActorType, action) &&
    reasonCode === null
  ) {
    throw new AuditValidationError(
      "reason_code is required for support and break-glass access",
    );
  }

  return {
    tenantId: parseTenantId(request.tenant_id),
    tenantPseudonym: null,
    actorType: actorType as AuditActorType,
    actorRef: requiredText(request.actor_ref, "actor_ref"),
    action,
    targetType,
    targetRef,
    result: result as AuditResult,
    reasonCode,
    context: parseContext(request.context_json),
    occurredAt: parseOccurredAt(request.occurred_at),
  };
}

@Injectable()
export class AuditService implements AuditEventHandler {
  constructor(
    @Inject(AUDIT_STORE_PROVIDER)
    private readonly store: AuditStoreProvider,
    @Optional()
    @Inject(AUDIT_CHAIN_SIGNING_KEY)
    private readonly signingKey?: string,
  ) {}

  async recordEvent(request: RecordEventRequest): Promise<RecordEventResponse> {
    const event = {
      ...validateRequest(request),
      id: createUuidV7(),
    };
    const seal = this.signingKey === undefined ? undefined : await this.trustedCheckpoint();
    const stored = seal === undefined ? await this.store.append(event) : await this.store.append(event, seal);
    return {
      id: auditId(stored.id),
      entry_hash: stored.entryHash.toString("hex"),
    };
  }

  async getEvent(request: GetEventRequest): Promise<GetEventResponse> {
    const eventId = requiredText(request.event_id, "event_id").replace(/^aud_/, "");
    const stored = await this.store.getById(eventId);
    // Real tenant-scoping happens here, not in the store: a caller can
    // only ever read an event recorded under their own tenant_id. An
    // event that doesn't exist and one that exists under a different
    // tenant are deliberately indistinguishable from outside.
    if (stored === undefined || stored.tenantId !== parseTenantId(request.tenant_id)) {
      throw new AuditEventNotFoundError(request.event_id);
    }
    return {
      id: auditId(stored.id),
      actor_type: stored.actorType,
      actor_ref: stored.actorRef ?? "",
      action: stored.action,
      target_type: stored.targetType ?? "",
      target_ref: stored.targetRef ?? "",
      result: stored.result,
      reason_code: stored.reasonCode ?? "",
      context_json: stored.context === null ? "" : JSON.stringify(stored.context),
      occurred_at: stored.occurredAt.toISOString(),
      entry_hash: stored.entryHash.toString("hex"),
    };
  }

  /**
   * Full re-verify from the latest checkpoint (Y2: verification starts from
   * the seal, because compaction destroys sealed rows and a genesis walk
   * would break on the first of them). With no checkpoint it walks from
   * genesis, as before. A forged signed anchor fails closed like the
   * incremental path. Bounded per pass like the incremental path; loops
   * until the head.
   */
  async verifyChain(): Promise<AuditChainVerificationResult> {
    if (this.signingKey === undefined) return verifyAuditChain(await this.store.readGlobalChain());
    const checkpoint = await this.trustedCheckpoint();
    let cursor = checkpoint?.lastEntryHash ?? auditGenesisHash();
    let position = checkpoint?.lastPosition ?? 0;
    let checked = 0;
    for (;;) {
      const events = await this.store.readChainSince(cursor, MAX_COMPACT_VERIFY_LIMIT, position);
      const result = verifyAuditChain(events, cursor);
      checked += result.checkedEvents;
      if (!result.valid) return { ...result, checkedEvents: checked };
      if (events.length === 0) return { valid: true, checkedEvents: checked };
      cursor = events[events.length - 1]!.entryHash;
      position = events[events.length - 1]!.chainPosition!;
    }
  }

  private async trustedCheckpoint(): Promise<AuditChainCheckpoint | undefined> {
    const checkpoint = await this.store.getChainCheckpoint();
    // Legacy unsigned checkpoints are not compaction seals. With a signing
    // key configured, validate their history from genesis before upgrading.
    if (checkpoint?.signature === undefined) return undefined;
    if (this.signingKey === undefined || checkpoint.lastPosition === undefined ||
        !verifyAuditCheckpointSignature(this.signingKey, checkpoint)) {
      throw new AuditValidationError("audit checkpoint signature mismatch");
    }
    return checkpoint;
  }

  /**
   * ENGINE-FIX-P3-13: the scheduled path. Resumes from the last checkpoint
   * instead of re-walking the whole table -- O(new entries), not O(all
   * history). The checkpoint only advances when the new segment verifies
   * clean; on a break, it's left exactly where it was so the same failure
   * keeps getting reported on every subsequent run until it's resolved,
   * instead of silently skipping past it.
   */
  async verifyChainIncremental(limit: number): Promise<AuditChainVerificationResult> {
    const checkpoint = this.signingKey === undefined
      ? await this.store.getChainCheckpoint() : await this.trustedCheckpoint();
    if (checkpoint?.signature !== undefined) {
      // A signed checkpoint that does not match its seal fails closed: the
      // anchor itself is suspect, so nothing anchored on it verifies.
      if (this.signingKey === undefined || !verifyAuditCheckpointSignature(this.signingKey, checkpoint)) {
        throw new AuditValidationError("audit checkpoint signature mismatch");
      }
    }
    const startingHash = checkpoint?.lastEntryHash ?? auditGenesisHash();
    const newEvents = await this.store.readChainSince(startingHash, limit, checkpoint?.lastPosition);
    if (newEvents.length === 0) {
      return { valid: true, checkedEvents: 0 };
    }

    const result = verifyAuditChain(newEvents, startingHash);
    if (result.valid) {
      const lastEvent = newEvents[newEvents.length - 1];
      if (lastEvent !== undefined) {
        const advanced: AuditChainCheckpoint = {
          lastEntryHash: lastEvent.entryHash,
          ...(lastEvent.chainPosition === undefined ? {} : { lastPosition: lastEvent.chainPosition }),
          checkedEvents: (checkpoint?.checkedEvents ?? 0) + result.checkedEvents,
          verifiedAt: new Date(),
        };
        await this.store.setChainCheckpoint(
          this.signingKey === undefined ? advanced : { ...advanced, signature: signAuditCheckpoint(this.signingKey, advanced) },
        );
      }
    }
    return result;
  }

  /**
   * Skeleton compaction sweep (D2, Y2). Advances the signed checkpoint to
   * the head of the valid chain, then destroys sealed skeletons past the
   * window. Fails closed without a signing key, on an invalid segment, on
   * a forged checkpoint, or when no signed anchor exists.
   */
  async compactSkeletons(now: Date = new Date()): Promise<{ sweptAt: string; deletedRows: number; checkpoint: string }> {
    if (this.signingKey === undefined) {
      throw new AuditValidationError("audit chain signing key is not configured");
    }
    await this.sealChain();
    const checkpoint = await this.trustedCheckpoint();
    if (checkpoint === undefined) throw new AuditValidationError("audit chain has no checkpoint to seal");
    const cutoff = new Date(now.getTime() - SKELETON_RETENTION_MS);
    const deletedRows = await this.store.expireSkeletons(cutoff, checkpoint.lastEntryHash, checkpoint.lastPosition);
    return { sweptAt: now.toISOString(), deletedRows, checkpoint: checkpoint.lastEntryHash.toString("hex") };
  }

  async sealChain(): Promise<AuditChainCheckpoint | undefined> {
    if (this.signingKey === undefined) throw new AuditValidationError("audit chain signing key is not configured");
    for (;;) {
      const result = await this.verifyChainIncremental(MAX_COMPACT_VERIFY_LIMIT);
      if (!result.valid) throw new AuditValidationError("audit chain segment invalid; compaction refused");
      if (result.checkedEvents === 0) {
        const checkpoint = await this.trustedCheckpoint();
        if (checkpoint !== undefined) return checkpoint;
        const empty: AuditChainCheckpoint = { lastEntryHash: auditGenesisHash(),
          lastPosition: 0, checkedEvents: 0, verifiedAt: new Date() };
        const sealed = { ...empty, signature: signAuditCheckpoint(this.signingKey, empty) };
        await this.store.setChainCheckpoint(sealed);
        return sealed;
      }
    }
  }

  // No actor_type or tenant_id restriction is applied here -- this is a
  // trusted-internal-caller capability (service-token authenticated, see
  // AuditQueryController). Which visibility policy applies (customer-scoped
  // vs staff-scoped) is platform-api's job, not audit-service's -- audit-
  // service has no concept of tenant RBAC or staff roles, those are Platform
  // concepts. A null tenantId performs a genuinely cross-tenant query.
  async queryEvents(request: {
    readonly tenantId: string;
    readonly actorTypes: readonly string[];
    readonly action: string;
    readonly result: string;
    readonly occurredAfter: string;
    readonly occurredBefore: string;
    readonly cursor: string;
    readonly limit: number;
  }): Promise<{
    readonly events: readonly GetEventResponse[];
    readonly next_cursor: string | null;
  }> {
    const tenantId = parseTenantId(request.tenantId);
    const actorTypes = request.actorTypes.filter(
      (value): value is AuditActorType =>
        ACTOR_TYPES.includes(value as AuditActorType),
    );
    if (request.actorTypes.length > 0 && actorTypes.length !== request.actorTypes.length) {
      throw new AuditValidationError("actor_types contains an unsupported value");
    }
    const result = optionalText(request.result, "result");
    if (result !== null && !AUDIT_RESULTS.includes(result as AuditResult)) {
      throw new AuditValidationError("result is not supported");
    }
    if (!Number.isInteger(request.limit) || request.limit < 1) {
      throw new AuditValidationError("limit must be a positive integer");
    }

    const action = optionalText(request.action, "action");
    const occurredAfterText = optionalText(request.occurredAfter, "occurred_after");
    const occurredBeforeText = optionalText(request.occurredBefore, "occurred_before");
    const cursor = optionalText(request.cursor, "cursor");

    const query: AuditEventQuery = {
      tenantId,
      ...(actorTypes.length > 0 ? { actorTypes } : {}),
      ...(action !== null ? { action } : {}),
      ...(result !== null ? { result: result as AuditResult } : {}),
      ...(occurredAfterText !== null ? { occurredAfter: parseOccurredAt(occurredAfterText) } : {}),
      ...(occurredBeforeText !== null ? { occurredBefore: parseOccurredAt(occurredBeforeText) } : {}),
      ...(cursor !== null ? { cursor: cursor.replace(/^aud_/, "") } : {}),
      limit: request.limit,
    };

    const { events, nextCursor } = await this.store.queryEvents(query);
    return {
      events: events.map((stored) => ({
        id: auditId(stored.id),
        actor_type: stored.actorType,
        actor_ref: stored.actorRef ?? "",
        action: stored.action,
        target_type: stored.targetType ?? "",
        target_ref: stored.targetRef ?? "",
        result: stored.result,
        reason_code: stored.reasonCode ?? "",
        context_json: stored.context === null ? "" : JSON.stringify(stored.context),
        occurred_at: stored.occurredAt.toISOString(),
        entry_hash: stored.entryHash.toString("hex"),
      })),
      next_cursor: nextCursor === null ? null : auditId(nextCursor),
    };
  }
}
