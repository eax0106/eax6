import { Inject, Injectable } from "@nestjs/common";

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
  signAuditChainCheckpoint,
  verifyAuditChain,
  verifyAuditChainCheckpointSignature,
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
const FULL_CHAIN_VERIFY_LIMIT = 2_147_483_647;
const LOCAL_CHECKPOINT_SIGNING_SECRET =
  "local-audit-chain-checkpoint-signing-secret-for-tests";
const LOCAL_CHECKPOINT_SIGNING_KEY_ID = "local-audit-chain-checkpoint";

export interface AuditChainCheckpointSigningConfig {
  readonly keyId: string;
  readonly secret: string;
}

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
  readonly #checkpointSigningSecret: string;
  readonly #checkpointSigningKeyId: string;

  constructor(
    @Inject(AUDIT_STORE_PROVIDER)
    private readonly store: AuditStoreProvider,
    signingConfig?: AuditChainCheckpointSigningConfig,
  ) {
    const runtimeMode = process.env.RUNTIME_MODE?.trim();
    const configuredSecret = signingConfig?.secret.trim();
    const configuredKeyId = signingConfig?.keyId.trim();
    if (runtimeMode === "real" && (configuredSecret === undefined || configuredSecret.length < 32)) {
      throw new AuditValidationError(
        "audit chain checkpoint signing key is required in real mode",
      );
    }
    if (runtimeMode === "real" && (configuredKeyId === undefined || configuredKeyId.length === 0)) {
      throw new AuditValidationError(
        "audit chain checkpoint signing key id is required in real mode",
      );
    }
    this.#checkpointSigningSecret = configuredSecret ?? LOCAL_CHECKPOINT_SIGNING_SECRET;
    this.#checkpointSigningKeyId = configuredKeyId ?? LOCAL_CHECKPOINT_SIGNING_KEY_ID;
  }

  async recordEvent(request: RecordEventRequest): Promise<RecordEventResponse> {
    const stored = await this.store.append({
      ...validateRequest(request),
      id: createUuidV7(),
    });
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
      actor_ref: stored.actorRef,
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

  /** Full re-verify from genesis. Loads the entire chain -- correct for a
   * one-off/disaster-recovery check, not for a periodic schedule (see
   * verifyChainIncremental). */
  async verifyChain(): Promise<AuditChainVerificationResult> {
    const checkpoint = await this.verifiedCheckpoint();
    if (checkpoint === undefined) {
      return verifyAuditChain(await this.store.readGlobalChain());
    }
    return verifyAuditChain(
      await this.store.readChainSince(
        checkpoint.lastEntryHash,
        FULL_CHAIN_VERIFY_LIMIT,
      ),
      checkpoint.lastEntryHash,
    );
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
    const checkpoint = await this.verifiedCheckpoint();
    const startingHash = checkpoint?.lastEntryHash ?? auditGenesisHash();
    const newEvents = await this.store.readChainSince(startingHash, limit);
    if (newEvents.length === 0) {
      return { valid: true, checkedEvents: 0 };
    }

    const result = verifyAuditChain(newEvents, startingHash);
    if (result.valid) {
      const lastEvent = newEvents[newEvents.length - 1];
      if (lastEvent !== undefined) {
        await this.store.setChainCheckpoint({
          lastEntryHash: lastEvent.entryHash,
          checkedEvents: (checkpoint?.checkedEvents ?? 0) + result.checkedEvents,
          verifiedAt: new Date(),
          signature: this.signCheckpoint({
            lastEntryHash: lastEvent.entryHash,
            checkedEvents: (checkpoint?.checkedEvents ?? 0) + result.checkedEvents,
            verifiedAt: new Date(),
            signature: Buffer.alloc(0),
            signatureKeyId: this.#checkpointSigningKeyId,
          }),
          signatureKeyId: this.#checkpointSigningKeyId,
        });
      }
    }
    return result;
  }

  async compactAuditEventsBeforeCheckpoint(): Promise<number> {
    const checkpoint = await this.verifiedCheckpoint();
    if (checkpoint === undefined) return 0;
    return this.store.compactAuditEventsBeforeCheckpoint(checkpoint.lastEntryHash);
  }

  private async verifiedCheckpoint(): Promise<AuditChainCheckpoint | undefined> {
    const checkpoint = await this.store.getChainCheckpoint();
    if (checkpoint === undefined) return undefined;
    if (!verifyAuditChainCheckpointSignature(checkpoint, this.#checkpointSigningSecret)) {
      throw new AuditValidationError("audit chain checkpoint signature is invalid");
    }
    return checkpoint;
  }

  private signCheckpoint(checkpoint: AuditChainCheckpoint): Buffer {
    return signAuditChainCheckpoint(checkpoint, this.#checkpointSigningSecret);
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
        actor_ref: stored.actorRef,
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
