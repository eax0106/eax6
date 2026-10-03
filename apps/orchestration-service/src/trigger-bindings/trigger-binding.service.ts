import {
  WEBHOOK_SECRET_ROTATION_POLICY,
  WEBHOOK_SIGNATURE_ALGORITHM,
  WEBHOOK_SIGNATURE_PAYLOAD_TEMPLATE,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  TriggerDispatchDetailSchema,
  type RotateWebhookSecretResult,
  type TriggerBinding,
  type TriggerBindingConfig,
  type WebhookDeliveryAccepted,
  type WebhookEndpoint,
} from "@alterx/contracts";
import type { MutableSecretsProvider } from "@alterx/shared-clients";
import { createHash } from "node:crypto";
import {
  bindingId as mintBindingId,
  secretReference,
  webhookEndpointId as mintEndpointId,
  webhookPathToken,
  webhookSecretId as mintSecretId,
  webhookSigningSecret,
} from "./ids";
import type {
  TriggerBindingRecord,
  TriggerBindingStore,
  WebhookEndpointRecord,
  WebhookRouting,
} from "./types";
import {
  TriggerBindingNotFoundError,
  TriggerBindingWorkspaceMismatchError,
  TriggerNotBindableError,
  WebhookEndpointNotFoundError,
  parseBindingConfig,
  parseBindingId,
  parseIntegrationId,
  parseTenantId,
  parseTriggerId,
  parseWebhookEndpointId,
  parseWorkspaceId,
} from "./validation";
import {
  verifyWebhookRequest,
  type SignatureRejection,
} from "./webhook-signature";

export class WebhookDeliveryRejectedError extends Error {
  /**
   * Machine-readable cause, for metrics only. Controllers must NOT put this
   * on the wire: an attacker probing an endpoint learns nothing beyond
   * "rejected".
   */
  readonly reason: SignatureRejection | "unknown_endpoint";

  constructor(reason: SignatureRejection | "unknown_endpoint") {
    super("Webhook delivery rejected");
    this.name = "WebhookDeliveryRejectedError";
    this.reason = reason;
  }
}

/**
 * INGR-7: the outbound side of dispatch. Implemented by the EventBridge
 * adapter in production; the eval harnesses simply leave the service
 * without a publisher (deliveries are accepted but not dispatched).
 */
export interface TriggerEventPublisher {
  publish(request: {
    readonly source: string;
    readonly detailType: string;
    readonly detail: unknown;
  }): Promise<void>;
}

const DEFAULT_MAX_SKEW_SECONDS = 300;

/**
 * Wire facts carried on every webhook-dispatched detail. The EventBridge
 * canonical rule matches the `alter.` source prefix.
 */
const TRIGGER_DELIVERY_SOURCE = "alter.trigger.delivered";
const TRIGGER_DELIVERY_DETAIL_TYPE = "trigger.delivered";
const TRIGGER_DELIVERY_EVENT_TYPE = "trigger.delivered";
const TRIGGER_DELIVERY_SCHEMA_VERSION = "v1";

export interface TriggerBindingServiceOptions {
  /** Public origin the webhook URLs are built from, e.g. https://hooks.alter.ai */
  readonly webhookBaseUrl: string;
  readonly maxSkewSeconds?: number;
}

export interface BindTriggerRequest {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly triggerId: string;
  readonly integrationId: string;
  readonly config: unknown;
}

export interface WebhookDeliveryRequest {
  readonly pathToken: string;
  readonly rawBody: Buffer;
  readonly signatureHeader: string | undefined;
  readonly timestampHeader: string | undefined;
  readonly now?: Date;
}

/**
 * ENG-BINDING core service.
 *
 * ROTATION MODEL -- HARD CUTOVER, ZERO OVERLAP (declared in
 * packages/contracts/src/trigger-bindings.ts and echoed on the wire in every
 * endpoint/rotation response):
 *
 *   rotateSecret() revokes the previous secret in the same transaction that
 *   inserts the replacement, then deletes the previous secret's material from
 *   SecretsProvider. Verification resolves only the single `active` secret
 *   row, so from the instant the rotate call returns, a request signed with
 *   the old secret fails with 401. There is no window in which both are
 *   accepted.
 *
 * SECRET HANDLING: generated values go straight to SecretsProvider and are
 * held in a local only as long as it takes to hand them over. Nothing in this
 * file writes a secret to the database, returns one in a response body, or
 * passes one to a logger.
 */
export class TriggerBindingService {
  readonly #store: TriggerBindingStore;
  readonly #secrets: MutableSecretsProvider;
  readonly #webhookBaseUrl: string;
  readonly #maxSkewSeconds: number;
  readonly #publisher: TriggerEventPublisher | undefined;

  constructor(
    store: TriggerBindingStore,
    secrets: MutableSecretsProvider,
    options: TriggerBindingServiceOptions,
    publisher?: TriggerEventPublisher,
  ) {
    this.#store = store;
    this.#secrets = secrets;
    this.#webhookBaseUrl = options.webhookBaseUrl.replace(/\/+$/, "");
    this.#maxSkewSeconds = options.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
    this.#publisher = publisher;
  }

  /**
   * Binds a trigger to an integration connection, provisioning that
   * integration's webhook endpoint on first use. Re-binding the same
   * (trigger, integration) pair updates the existing binding instead of
   * creating a second one, and reuses the same endpoint -- endpoints are per
   * integration, not per binding.
   */
  async bindTrigger(request: BindTriggerRequest): Promise<TriggerBinding> {
    const tenantId = parseTenantId(request.tenantId);
    const workspaceId = parseWorkspaceId(request.workspaceId);
    const triggerId = parseTriggerId(request.triggerId);
    const integrationId = parseIntegrationId(request.integrationId);
    const config = parseBindingConfig(request.config);

    const scope = await this.#store.findTriggerScope(tenantId, triggerId);
    if (scope === null) {
      throw new TriggerBindingNotFoundError(triggerId);
    }
    if (scope.workspaceId !== workspaceId) {
      throw new TriggerBindingWorkspaceMismatchError(triggerId);
    }
    if (scope.type !== "webhook") {
      throw new TriggerNotBindableError(triggerId, scope.type);
    }

    const endpoint = await this.#ensureEndpoint(
      tenantId,
      workspaceId,
      integrationId,
    );
    const record = await this.#store.upsertBinding(tenantId, {
      id: mintBindingId(),
      workspaceId,
      triggerId,
      integrationId,
      webhookEndpointId: endpoint.id,
      config,
    });
    return projectBinding(record);
  }

  async listBindings(
    tenantId: string,
    triggerId: string,
    workspaceId?: string,
  ): Promise<{ readonly bindings: readonly TriggerBinding[] }> {
    if (workspaceId !== undefined) {
      const scope = await this.#store.findTriggerScope(parseTenantId(tenantId), parseTriggerId(triggerId));
      if (scope === null || scope.workspaceId.replace(/^ws_/, "") !== workspaceId) throw new TriggerBindingNotFoundError(triggerId);
    }
    const records = await this.#store.listBindings(
      parseTenantId(tenantId),
      parseTriggerId(triggerId),
    );
    return { bindings: records.map(projectBinding) };
  }

  async disableBinding(
    tenantId: string,
    triggerId: string,
    bindingId: string,
  ): Promise<TriggerBinding> {
    const record = await this.#store.disableBinding(
      parseTenantId(tenantId),
      parseTriggerId(triggerId),
      parseBindingId(bindingId),
    );
    if (record === null) {
      throw new TriggerBindingNotFoundError(bindingId);
    }
    return projectBinding(record);
  }

  /** Reads an integration's endpoint. Never discloses secret material. */
  async getEndpointForIntegration(
    tenantId: string,
    workspaceId: string,
    integrationId: string,
  ): Promise<WebhookEndpoint> {
    const parsedTenant = parseTenantId(tenantId);
    const endpoint = await this.#store.findEndpointByIntegration(
      parsedTenant,
      parseWorkspaceId(workspaceId),
      parseIntegrationId(integrationId),
    );
    if (endpoint === null) {
      throw new WebhookEndpointNotFoundError(integrationId);
    }
    const secret = await this.#store.findActiveSecret(parsedTenant, endpoint.id);
    if (secret === null) {
      // An endpoint with no active secret cannot verify anything. Migration
      // 0022 creates both rows in one transaction, so this means external
      // tampering, not a normal state.
      throw new WebhookEndpointNotFoundError(endpoint.id);
    }
    return {
      id: endpoint.id,
      tenantId: endpoint.tenantId,
      workspaceId: endpoint.workspaceId,
      integrationId: endpoint.integrationId,
      url: this.webhookUrl(endpoint.pathToken),
      signatureHeader: WEBHOOK_SIGNATURE_HEADER,
      timestampHeader: WEBHOOK_TIMESTAMP_HEADER,
      signatureAlgorithm: WEBHOOK_SIGNATURE_ALGORITHM,
      signaturePayloadTemplate: WEBHOOK_SIGNATURE_PAYLOAD_TEMPLATE,
      maxSkewSeconds: endpoint.maxSkewSeconds,
      activeSecretVersion: secret.version,
      // Version 1 is the endpoint's original secret, never a rotation.
      secretRotatedAt:
        secret.version > 1 ? secret.createdAt.toISOString() : null,
      rotationPolicy: { ...WEBHOOK_SECRET_ROTATION_POLICY },
      createdAt: endpoint.createdAt.toISOString(),
    };
  }

  /** Full public URL for a path token. The token is the only secret-ish part. */
  webhookUrl(pathToken: string): string {
    return `${this.#webhookBaseUrl}/api/v1/webhooks/integrations/${pathToken}`;
  }

  /**
   * Rotates an endpoint's signing secret under the declared hard-cutover
   * model. Ordering matters and is deliberate:
   *
   *   1. put the NEW secret in SecretsProvider (a failure here leaves the old
   *      secret working -- no window with zero valid secrets),
   *   2. commit revoke-old + insert-new atomically (this is the instant the
   *      old secret stops verifying, because verification reads only the
   *      active row),
   *   3. delete the OLD material from SecretsProvider.
   *
   * If step 2 fails, step 1 is rolled back so no orphan material is left
   * behind. If step 3 fails the secret is already unreachable -- the revoked
   * row is never resolved -- so the failure is swallowed rather than
   * resurrecting a rotation that already committed.
   */
  async rotateSecret(
    tenantId: string,
    endpointId: string,
  ): Promise<RotateWebhookSecretResult> {
    const parsedTenant = parseTenantId(tenantId);
    const parsedEndpoint = parseWebhookEndpointId(endpointId);

    const endpoint = await this.#store.findEndpointById(
      parsedTenant,
      parsedEndpoint,
    );
    if (endpoint === null) {
      throw new WebhookEndpointNotFoundError(parsedEndpoint);
    }

    const current = await this.#store.findActiveSecret(
      parsedTenant,
      parsedEndpoint,
    );
    const nextVersion = (current?.version ?? 0) + 1;
    const nextRef = secretReference(parsedTenant, parsedEndpoint, nextVersion);

    await this.#secrets.putSecret(nextRef, webhookSigningSecret());

    let outcome;
    try {
      outcome = await this.#store.rotateSecret(
        parsedTenant,
        parsedEndpoint,
        { id: mintSecretId(), version: nextVersion, secretRef: nextRef },
        new Date(),
      );
    } catch (error: unknown) {
      await this.#bestEffortDelete(nextRef);
      throw error;
    }

    if (outcome.previous !== null) {
      await this.#bestEffortDelete(outcome.previous.secretRef);
    }

    return {
      endpointId: parsedEndpoint,
      activeSecretVersion: outcome.next.version,
      previousSecretVersion: outcome.previous?.version ?? null,
      previousSecretInvalidatedAt:
        outcome.previous?.revokedAt?.toISOString() ?? null,
      rotatedAt: outcome.rotatedAt.toISOString(),
      rotationPolicy: { ...WEBHOOK_SECRET_ROTATION_POLICY },
    };
  }

  /**
   * Verifies and routes an inbound delivery. Every rejection path -- unknown
   * token, skewed timestamp, bad signature -- surfaces the same opaque
   * error, so the receiver cannot be used as an oracle for which endpoints
   * exist or which secret is current.
   *
   * INGR-7: every matched binding whose trigger is `enabled` with an active
   * version is published to the event bus (deduped by trigger id -- two
   * bindings matching the same delivery produce ONE dispatch per trigger).
   * The response contract is unchanged: the receiver still returns the
   * matched binding ids, and dispatch happens asynchronously via the queue.
   */
  async receiveDelivery(
    request: WebhookDeliveryRequest,
  ): Promise<WebhookDeliveryAccepted> {
    const routing = await this.#store.resolveByPathToken(request.pathToken);
    if (routing === null) {
      throw new WebhookDeliveryRejectedError("unknown_endpoint");
    }

    const secret = await this.#secrets.getSecret(routing.secretRef);
    const verdict = verifyWebhookRequest({
      rawBody: request.rawBody,
      signatureHeader: request.signatureHeader,
      timestampHeader: request.timestampHeader,
      secret,
      maxSkewSeconds: routing.maxSkewSeconds,
      ...(request.now === undefined ? {} : { now: request.now }),
    });
    if (!verdict.ok) {
      throw new WebhookDeliveryRejectedError(verdict.reason);
    }

    const bindings = await this.#store.listActiveBindingsForEndpoint(
      routing.tenantId,
      routing.endpointId,
    );
    const payload = decodePayload(request.rawBody);
    const matched = bindings.filter((binding) =>
      matchesBinding(binding.config, payload),
    );
    const uniqueTriggerIds = [...new Set(matched.map((binding) => binding.triggerId))];

    if (this.#publisher !== undefined) {
      await this.#dispatchTriggeredDeliveries(
        routing,
        uniqueTriggerIds,
        payload,
        request.rawBody,
      );
    }

    return {
      endpointId: routing.endpointId,
      accepted: true,
      matchedBindingIds: matched.map((binding) => binding.id),
    };
  }

  async #dispatchTriggeredDeliveries(
    routing: WebhookRouting,
    triggerIds: readonly string[],
    payload: Record<string, unknown>,
    rawBody: Buffer,
  ): Promise<void> {
    for (const triggerId of triggerIds) {
      const info = await this.#store.findTriggerDispatchInfo(
        routing.tenantId,
        triggerId,
      );
      if (
        info === null ||
        info.status !== "enabled" ||
        info.type !== "webhook" ||
        info.activeVersion === null ||
        info.dlqMaxReceiveCount === null ||
        this.#publisher === undefined
      ) {
        continue;
      }
      const detail = TriggerDispatchDetailSchema.parse({
        source: TRIGGER_DELIVERY_SOURCE,
        detail_type: TRIGGER_DELIVERY_DETAIL_TYPE,
        event_type: TRIGGER_DELIVERY_EVENT_TYPE,
        schema_version: TRIGGER_DELIVERY_SCHEMA_VERSION,
        tenant_id: `ten_${routing.tenantId}`,
        workspace_id: info.workspaceId.startsWith("ws_")
          ? info.workspaceId
          : `ws_${info.workspaceId}`,
        trigger_id: triggerId,
        trigger_version: info.activeVersion,
        idempotency_key: webhookIdempotencyKey(routing.endpointId, rawBody),
        payload,
        dlq_max_receive_count: info.dlqMaxReceiveCount,
      });
      await this.#publisher.publish({
        source: detail.source,
        detailType: detail.detail_type,
        detail,
      });
    }
  }

  async #ensureEndpoint(
    tenantId: string,
    workspaceId: string,
    integrationId: string,
  ): Promise<WebhookEndpointRecord> {
    const existing = await this.#store.findEndpointByIntegration(
      tenantId,
      workspaceId,
      integrationId,
    );
    if (existing !== null) {
      return existing;
    }

    const endpointId = mintEndpointId();
    const secretRef = secretReference(tenantId, endpointId, 1);
    await this.#secrets.putSecret(secretRef, webhookSigningSecret());
    try {
      const created = await this.#store.createEndpointWithSecret(
        tenantId,
        {
          id: endpointId,
          workspaceId,
          integrationId,
          pathToken: webhookPathToken(),
          maxSkewSeconds: this.#maxSkewSeconds,
        },
        { id: mintSecretId(), version: 1, secretRef },
      );
      return created.endpoint;
    } catch (error: unknown) {
      await this.#bestEffortDelete(secretRef);
      throw error;
    }
  }

  async #bestEffortDelete(reference: string): Promise<void> {
    try {
      await this.#secrets.deleteSecret(reference);
    } catch {
      // Deliberately swallowed. Never log the reference's resolved value;
      // never surface provider errors to a webhook sender.
    }
  }

  /** Static wire facts a client needs to sign a request correctly. */
  static readonly signingContract = Object.freeze({
    signatureHeader: WEBHOOK_SIGNATURE_HEADER,
    timestampHeader: WEBHOOK_TIMESTAMP_HEADER,
    signatureAlgorithm: WEBHOOK_SIGNATURE_ALGORITHM,
    signaturePayloadTemplate: WEBHOOK_SIGNATURE_PAYLOAD_TEMPLATE,
  } as const);
}

function projectBinding(record: TriggerBindingRecord): TriggerBinding {
  return {
    id: record.id,
    tenantId: record.tenantId,
    workspaceId: record.workspaceId,
    triggerId: record.triggerId,
    integrationId: record.integrationId,
    webhookEndpointId: record.webhookEndpointId,
    config: record.config,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * Deterministic per-(endpoint, raw body) idempotency key. A redelivery of
 * the same bytes (SQS already-deduplicated, or a sender retry with an
 * identical body) maps to the same key and is dropped by the unique
 * (tenant, idempotency_key) index on events.
 */
function webhookIdempotencyKey(endpointId: string, rawBody: Buffer): string {
  return createHash("sha256")
    .update(`${endpointId}\n`)
    .update(rawBody)
    .digest("hex");
}

function decodePayload(rawBody: Buffer): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(rawBody.toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // A signed-but-unparseable body is still authentic; it simply matches no
    // event-type filter. Rejecting it would let a sender's malformed payload
    // look like a signature failure.
    return {};
  }
}

function matchesBinding(
  config: TriggerBindingConfig,
  payload: Record<string, unknown>,
): boolean {
  const eventType = payload.type ?? payload.event_type ?? payload.event;
  if (typeof eventType !== "string") {
    return false;
  }
  if (!config.eventTypes.includes(eventType)) {
    return false;
  }
  if (config.filter === undefined) {
    return true;
  }
  return Object.entries(config.filter).every(
    ([key, value]) => payload[key] === value,
  );
}
