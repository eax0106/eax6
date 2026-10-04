import type {
  FallbackBinding,
  ModelAlias,
  ModelAliasBinding,
  ProviderCapabilities,
} from "@alterx/contracts";

export const CANONICAL_PROVIDER_INTERFACES = [
  "DurableExecutionProvider",
  "ComputeProvider",
  "IdentityProvider",
  "ModelProvider",
  "EmbeddingProvider",
  "ImageGenProvider",
  "TextToSpeechProvider",
  "SpeechToTextProvider",
  "PIIRedactionProvider",
  "SearchProvider",
  "BrowserProvider",
  "DeploymentProvider",
  "ObjectStorageProvider",
  "QueueProvider",
  "QueueMessageConsumer",
  "CronScheduleManager",
  "SecretsProvider",
  "ParameterStoreProvider",
  "BillingProvider",
  "KycProvider",
  "MarketplacePayoutProvider",
  "ObservabilityProvider",
  "SandboxProvider",
  "RepositoryProvider",
  "ConfigProvider",
  "RelationalDatabaseProvider",
  "VectorStoreProvider",
  "CacheProvider",
  "EventBusProvider",
  "GPUComputeProvider",
  "NetworkConnectivityProvider",
  "AuditStoreProvider",
  "NotificationProvider",
  "EmailProvider",
  "StatusPageProvider",
] as const;

export type CanonicalProviderInterfaceName =
  (typeof CANONICAL_PROVIDER_INTERFACES)[number];

export type JsonValue =
  | boolean
  | number
  | string
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface MigrationSupport {
  readonly strategyVersion: string;
  readonly rollbackSupported: boolean;
}

export interface ProviderMetadata<
  TInterface extends CanonicalProviderInterfaceName = CanonicalProviderInterfaceName,
> {
  readonly providerId: string;
  readonly interfaceName: TInterface;
  readonly displayName: string;
  readonly version: string;
  readonly telemetryNamespace: string;
  readonly featureFlag?: string;
  readonly supportsTenantOverrides: boolean;
  readonly migration: MigrationSupport;
}

export interface ProviderHealth {
  readonly status: HealthStatus;
  readonly checkedAt: string;
  readonly latencyMs: number;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

export interface BaseProvider<
  TInterface extends CanonicalProviderInterfaceName = CanonicalProviderInterfaceName,
> {
  readonly metadata: ProviderMetadata<TInterface>;
  readonly capabilities: ProviderCapabilities;
  healthCheck(): Promise<ProviderHealth>;
}

export type SecretReferenceId = string;

export interface SecretsProvider extends BaseProvider<"SecretsProvider"> {
  getSecret(referenceId: SecretReferenceId): Promise<string>;
}

export interface MutableSecretsProvider extends SecretsProvider {
  putSecret(referenceId: SecretReferenceId, value: string): Promise<void>;
  deleteSecret(referenceId: SecretReferenceId): Promise<void>;
}

/**
 * A secrets provider that can enumerate its references under a prefix, so a
 * tenant's erasure can delete every secret it owns and verify none is left.
 * deleteSecret must be idempotent: deleting a missing reference succeeds.
 */
export interface ErasableSecretsProvider extends MutableSecretsProvider {
  listSecretReferences(prefix: string): Promise<readonly SecretReferenceId[]>;
}

/** Resolves non-secret runtime configuration from a named parameter store. */
export interface ParameterStoreProvider extends BaseProvider<"ParameterStoreProvider"> {
  getParameter(name: string): Promise<string>;
}

export interface MutableParameterStoreProvider extends ParameterStoreProvider {
  putParameter(name: string, value: string): Promise<void>;
  deleteParameter(name: string): Promise<void>;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface BillingPlan {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly amount: number;
  readonly currency: string;
  readonly interval: number;
  readonly period: "daily" | "weekly" | "monthly" | "yearly";
  readonly active: boolean;
}

export interface SubscriptionCheckoutInput {
  readonly internalPlanId: string;
  readonly expectedTotalMinor: number;
  readonly currency: "INR";
  readonly gstin?: string;
}

export interface Subscription {
  readonly id: string;
  readonly tenantId: string;
  readonly planId: string;
  readonly status:
    | "created"
    | "authenticated"
    | "active"
    | "pending"
    | "halted"
    | "cancelled"
    | "completed"
    | "expired";
  readonly currentPeriodStart: string | null;
  readonly currentPeriodEnd: string | null;
  readonly providerCustomerRef: string | null;
  readonly checkoutUrl?: string;
}

export interface Invoice {
  readonly id: string;
  readonly subscriptionId: string | null;
  readonly amount: number;
  readonly currency: string;
  readonly status: string;
  readonly issuedAt: string;
  readonly paidAt: string | null;
  /** The provider's hosted invoice page (view and PDF download); null when it has none. */
  readonly documentUrl: string | null;
}

export interface PaymentMethodRef {
  readonly ref: string;
  readonly type: string;
  readonly brand: string | null;
  readonly last4: string | null;
}

export interface BillingEvent {
  readonly id: string;
  readonly type: string;
  readonly createdAt: string;
  readonly payload: JsonValue;
}

export interface BillingRefund {
  readonly id: string;
  readonly paymentRef: string;
  readonly amount: number;
  readonly currency: string;
  readonly status: string;
  readonly speed: "normal" | "optimum";
  readonly createdAt: string;
}

export interface BillingDispute {
  readonly id: string;
  readonly paymentRef: string;
  readonly amount: number;
  readonly currency: string;
  readonly status: "open" | "under_review" | "won" | "lost" | "closed";
  readonly phase: string;
  readonly respondBy: string | null;
}

export interface BillingDisputeResolution {
  readonly action: "accept" | "contest";
  readonly reason: string;
  readonly evidenceRefs: readonly string[];
}

export interface BillingProvider extends BaseProvider<"BillingProvider"> {
  listPlans(): Promise<BillingPlan[]>;
  getSubscription(tenantId: string): Promise<Subscription | null>;
  createSubscription(
    tenantId: string,
    planId: string,
    paymentMethodRef: string,
  ): Promise<Subscription>;
  createCheckoutSubscription?(
    tenantId: string,
    planId: string,
    input: SubscriptionCheckoutInput,
  ): Promise<Subscription>;
  changeSubscription(tenantId: string, planId: string): Promise<Subscription>;
  cancelSubscription(tenantId: string): Promise<Subscription>;
  listInvoices(
    tenantId: string,
    cursor?: string,
    limit?: number,
  ): Promise<Page<Invoice>>;
  attachPaymentMethod(
    tenantId: string,
    providerToken: string,
  ): Promise<PaymentMethodRef>;
  listPaymentMethods(tenantId: string): Promise<PaymentMethodRef[]>;
  detachPaymentMethod(tenantId: string, ref: string): Promise<void>;
  refundPayment(
    paymentRef: string,
    amountMinor: number,
    speed: "normal" | "optimum",
    reason: string,
  ): Promise<BillingRefund>;
  resolveDispute(
    disputeRef: string,
    resolution: BillingDisputeResolution,
  ): Promise<BillingDispute>;
  verifyWebhookSignature(
    rawBody: Uint8Array,
    signature: string,
    secret: string,
  ): boolean;
  parseWebhookEvent(rawBody: Uint8Array): BillingEvent;
}

export interface KycDocumentRef {
  readonly type: "tax_id" | "bank_proof";
  readonly objectRef: string;
}

export interface KycSubmission {
  readonly id: string;
  readonly tenantId: string;
  readonly documents: readonly KycDocumentRef[];
  readonly status: "pending_review" | "approved" | "rejected";
  readonly rejectionReason: string | null;
  readonly submittedAt: string;
  readonly reviewedAt: string | null;
}

/** Identity-document verification has no selected vendor; manual review is the current adapter. */
export interface KycProvider extends BaseProvider<"KycProvider"> {
  submitVerification(
    tenantId: string,
    documents: readonly KycDocumentRef[],
  ): Promise<KycSubmission>;
  getVerificationStatus(tenantId: string): Promise<KycSubmission | null>;
}

export interface PayoutSplitResult {
  readonly payoutId: string;
  readonly orderRef: string;
  readonly sellerShareMinor: string;
  readonly platformShareMinor: string;
  readonly status: "created" | "pending" | "processed" | "failed";
}

export interface PayoutStatus {
  readonly payoutId: string;
  readonly status: "created" | "pending" | "processed" | "failed";
  readonly processedAt: string | null;
}

export interface MarketplacePayoutProvider
  extends BaseProvider<"MarketplacePayoutProvider"> {
  createSplitOrder(
    orderId: string,
    sellerAccountRef: string,
    totalMinor: string,
    sellerShareBps: number,
  ): Promise<PayoutSplitResult>;
  getPayoutStatus(payoutId: string): Promise<PayoutStatus>;
}

export interface TraceSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly name: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface MetricPoint {
  readonly name: string;
  readonly value: number;
  readonly recordedAt: string;
  readonly unit?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface LogEntry {
  readonly severity: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly recordedAt: string;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface ErrorCapture {
  readonly name: string;
  readonly message: string;
  readonly occurredAt: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface ObservabilityProvider
  extends BaseProvider<"ObservabilityProvider"> {
  emitTrace(span: TraceSpan): Promise<void>;
  emitMetric(metric: MetricPoint): Promise<void>;
  emitLog(entry: LogEntry): Promise<void>;
  captureError(error: ErrorCapture): Promise<void>;
}

export interface StartWorkflowRequest {
  readonly workflowId: string;
  readonly workflowType: string;
  readonly input: JsonValue;
  /** Temporal duration string limiting one durable workflow execution. */
  readonly executionTimeout?: string;
}

export interface DurableWorkflowHandle {
  readonly workflowId: string;
  readonly runId: string;
}

export interface SignalWorkflowRequest {
  readonly workflowId: string;
  readonly signalName: string;
  readonly payload: JsonValue;
}

export interface WorkflowQueryRequest {
  readonly workflowId: string;
  readonly queryName: "input" | "signals" | "status";
}

export interface WorkflowQueryResult {
  readonly workflowId: string;
  readonly queryName: WorkflowQueryRequest["queryName"];
  readonly value: JsonValue;
}

export interface TerminateWorkflowRequest {
  readonly workflowId: string;
  readonly reason: string;
}

export interface DurableExecutionProvider
  extends BaseProvider<"DurableExecutionProvider"> {
  startWorkflow(request: StartWorkflowRequest): Promise<DurableWorkflowHandle>;
  signalWorkflow(request: SignalWorkflowRequest): Promise<void>;
  queryWorkflow(request: WorkflowQueryRequest): Promise<WorkflowQueryResult>;
  terminateWorkflow(request: TerminateWorkflowRequest): Promise<void>;
}

export interface ComputeProvider extends BaseProvider<"ComputeProvider"> {}
export interface IdentityProvider extends BaseProvider<"IdentityProvider"> {}

/** Reserved provider marker; in-app notifications are Platform-owned storage. */
export interface NotificationProvider extends BaseProvider<"NotificationProvider"> {}

export interface EmailSendResult {
  readonly messageId: string;
  readonly acceptedAt: string;
}

export interface EmailProvider extends BaseProvider<"EmailProvider"> {
  sendTemplatedEmail(
    to: string,
    templateId: string,
    variables: Record<string, string>,
    locale?: string,
  ): Promise<EmailSendResult>;
  /** Free-text send: no AWS SES template registration required (SES's
   * Content.Simple shape instead of Content.Template) -- for callers like
   * a workflow tool action that need arbitrary subject/body content, not
   * one of the platform's own fixed, pre-registered notification
   * templates. */
  sendEmail(
    to: string,
    subject: string,
    body: string,
    options?: { readonly html?: boolean; readonly tenantId?: string },
  ): Promise<EmailSendResult>;
}

export interface StatusPageIncidentRequest {
  readonly title: string;
  readonly body: string;
  readonly status: "investigating" | "monitoring" | "resolved";
  readonly impact: "none" | "minor" | "major" | "critical";
  readonly notifySubscribers: boolean;
}

export interface StatusPageIncident {
  readonly providerIncidentRef: string;
  readonly status: StatusPageIncidentRequest["status"];
  readonly publishedAt: string;
}

export interface StatusPageProvider extends BaseProvider<"StatusPageProvider"> {
  publishIncident(request: StatusPageIncidentRequest): Promise<StatusPageIncident>;
}

export interface ModelInvocationRequest {
  readonly tenantId: string;
  readonly runId: string;
  readonly nodeExecutionId: string;
  readonly modelId: string;
  readonly capabilityTags: readonly string[];
  readonly inputJson: string;
  // Ordered fallback providers to try, in order, only after modelId (the
  // primary, Bedrock-hosted model) fails. Empty/absent = no failover.
  readonly fallbackChain?: readonly FallbackBinding[];
}

export interface ModelInvocationResult {
  readonly outputJson: string;
  readonly usageJson: string;
  // The providerId (BaseProvider.metadata.providerId) that actually served
  // this invocation -- the primary adapter, or whichever fallbackChain
  // entry succeeded. Never silently absent: callers must always be able to
  // see whether a downgrade happened.
  readonly servedBy: string;
  // The model id that served it. servedBy names only the provider, and one
  // provider serves models at very different prices, so pricing a call needs
  // this; under failover it is the fallback entry's model, not the primary's.
  // Optional so a provider that predates it still type-checks -- the gateway
  // then prices the alias's bound model, which is right whenever no failover
  // happened.
  readonly servedModelId?: string;
}

export type ModelInvocationStreamChunk =
  | {
      readonly sequence: number;
      readonly delta: string;
      readonly final: false;
      readonly servedBy: string;
    }
  | {
      readonly sequence: number;
      readonly delta: string;
      readonly final: true;
      readonly usageJson: string;
      readonly servedBy: string;
      // As ModelInvocationResult.servedModelId.
      readonly servedModelId?: string;
    };

export interface ModelProvider extends BaseProvider<"ModelProvider"> {
  invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult>;
  stream(request: ModelInvocationRequest): AsyncIterable<ModelInvocationStreamChunk>;
}

export type EmbeddingDimensions = 512 | 1024;

export interface EmbeddingRequest {
  readonly tenantId: string;
  readonly text: string;
  readonly dimensions: EmbeddingDimensions;
}

export interface EmbeddingResult {
  readonly vector: readonly number[];
  readonly dimensions: EmbeddingDimensions;
  readonly modelId: string;
}

export interface EmbeddingProvider extends BaseProvider<"EmbeddingProvider"> {
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}

/**
 * Covers two call shapes through one adapter implementation: a workflow
 * node generating an image mid-run (runId/nodeExecutionId present), and a
 * standalone BFF "test this media config" call with no run to attach to
 * (runId/nodeExecutionId omitted). tenantId is required in both cases.
 */
export interface ImageGenerationRequest {
  readonly tenantId: string;
  readonly runId?: string;
  readonly nodeExecutionId?: string;
  readonly prompt: string;
  readonly options: Readonly<Record<string, JsonValue>>;
}

export interface ImageGenerationResult {
  /** Opaque ObjectStorageProvider reference (an S3 key in the AWS adapter). */
  readonly reference: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  /** The adapter that wrote this exact object; never the preferred provider. */
  readonly servedBy: string;
}

export interface ImageGenProvider extends BaseProvider<"ImageGenProvider"> {
  generateImage(
    request: ImageGenerationRequest,
  ): Promise<ImageGenerationResult>;
}

/**
 * Covers two call shapes through one adapter implementation: a workflow
 * node synthesizing speech mid-run (runId/nodeExecutionId present), and a
 * standalone BFF "test this media config" call with no run to attach to
 * (runId/nodeExecutionId omitted). tenantId is required in both cases.
 */
export interface SpeechSynthesisRequest {
  readonly tenantId: string;
  readonly runId?: string;
  readonly nodeExecutionId?: string;
  readonly text: string;
  readonly voiceConfig: Readonly<Record<string, JsonValue>>;
}

export interface SpeechSynthesisResult {
  /** Opaque ObjectStorageProvider reference (an S3 key in the AWS adapter). */
  readonly reference: string;
  readonly mimeType: string;
  readonly durationMs: number;
}

export interface TextToSpeechProvider
  extends BaseProvider<"TextToSpeechProvider"> {
  synthesizeSpeech(
    request: SpeechSynthesisRequest,
  ): Promise<SpeechSynthesisResult>;
}

/**
 * Covers two call shapes through one adapter implementation: a workflow
 * node transcribing audio mid-run (runId/nodeExecutionId present), and a
 * standalone BFF "test this media config" call with no run to attach to
 * (runId/nodeExecutionId omitted). tenantId is required in both cases.
 */
export interface SpeechTranscriptionRequest {
  readonly tenantId: string;
  readonly runId?: string;
  readonly nodeExecutionId?: string;
  /** Opaque ObjectStorageProvider reference; audio bytes never cross the RPC. */
  readonly audioRef: string;
}

export interface SpeechTranscriptionResult {
  readonly transcript: string;
  readonly confidence: number;
}

export interface SpeechToTextProvider
  extends BaseProvider<"SpeechToTextProvider"> {
  transcribe(
    request: SpeechTranscriptionRequest,
  ): Promise<SpeechTranscriptionResult>;
}
export interface PIIDetectedEntity {
  readonly entityType: string;
  readonly start: number;
  readonly end: number;
  readonly score: number;
}

export interface PIIRedactionRequest {
  readonly tenantId: string;
  readonly text: string;
}

export interface PIIRedactionResult {
  readonly redactedText: string;
  readonly entities: readonly PIIDetectedEntity[];
}

export interface PIIRedactionProvider
  extends BaseProvider<"PIIRedactionProvider"> {
  redact(request: PIIRedactionRequest): Promise<PIIRedactionResult>;
}
export interface SearchRequest {
  readonly tenantId: string;
  readonly query: string;
  readonly maxResults?: number;
}

export interface SearchResultItem {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly score: number;
}

export interface SearchResult {
  readonly results: readonly SearchResultItem[];
}

export interface SearchProvider extends BaseProvider<"SearchProvider"> {
  search(request: SearchRequest): Promise<SearchResult>;
}
export interface BrowserInspectionRequest {
  readonly url: string;
  readonly timeoutMs?: number;
}

export interface BrowserInspectionResult {
  readonly url: string;
  readonly statusCode: number;
  readonly hasVisibleContent: boolean;
  readonly pageError?: string;
  readonly consoleErrors: readonly string[];
}

export interface BrowserProvider extends BaseProvider<"BrowserProvider"> {
  inspectPage(request: BrowserInspectionRequest): Promise<BrowserInspectionResult>;
}
export interface ArtifactDeploymentRequest {
  readonly tenantId: string;
  readonly projectId: string;
  readonly artifactId: string;
  /** Durable object reference; future runtime providers fetch it themselves. */
  readonly sourceReference: string;
  readonly contentType: string;
}
export interface ArtifactDeploymentResult {
  readonly deploymentReference: string;
}
export interface DeploymentProvider
  extends BaseProvider<"DeploymentProvider"> {
  deployArtifact(
    request: ArtifactDeploymentRequest,
  ): Promise<ArtifactDeploymentResult>;
}
export interface ObjectStorageProvider
  extends BaseProvider<"ObjectStorageProvider"> {
  putObject(
    reference: string,
    body: Buffer,
    contentType: string,
  ): Promise<void>;
  getObject(reference: string): Promise<Buffer>;
  deleteObject(reference: string): Promise<void>;
  objectExists(reference: string): Promise<boolean>;
  createPresignedDownloadUrl(reference: string, expiresInSeconds: number): Promise<string>;
}
export interface QueueProvider extends BaseProvider<"QueueProvider"> {
  publish(queueName: string, message: JsonValue): Promise<void>;
  consume(queueName: string): Promise<JsonValue | undefined>;
}

/**
 * INGR-7: visibility-timeout-based SQS receipt for the canonical-events
 * consumer. Unlike QueueProvider.consume() (which deletes on receipt),
 * receive() leaves the message in flight so a failed delivery is
 * redelivered by SQS itself, and carries ApproximateReceiveCount so the
 * consumer can enforce per-trigger DlqPolicy bounds.
 */
export interface QueueMessageReceipt {
  readonly receiptHandle: string;
  readonly body: JsonValue;
  readonly approximateReceiveCount: number;
}

export interface QueueMessageConsumer extends BaseProvider<"QueueMessageConsumer"> {
  receive(queueName: string): Promise<QueueMessageReceipt | undefined>;
  delete(queueName: string, receiptHandle: string): Promise<void>;
}

export interface CronScheduleUpsertRequest {
  readonly scheduleId: string;
  readonly cronExpression: string;
  readonly workflowType: string;
  readonly input: JsonValue;
}

/**
 * INGR-7: cron-trigger scheduling owned by the durable execution provider.
 * One schedule per trigger id; upsert replaces in place (Temporal schedules
 * with the same id are updated, not duplicated), delete removes it.
 */
export interface CronScheduleManager extends BaseProvider<"CronScheduleManager"> {
  upsertCronSchedule(request: CronScheduleUpsertRequest): Promise<void>;
  deleteCronSchedule(scheduleId: string): Promise<void>;
}
export interface SandboxSessionCreateRequest {
  readonly tenantId: string;
  readonly runId: string;
  readonly cycleId: string;
  readonly templateId: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface SandboxSession {
  readonly sessionId: string;
  readonly expiresAt: string;
}

export interface SandboxFile {
  readonly path: string;
  readonly content: string;
}

export interface SandboxCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SandboxProvider extends BaseProvider<"SandboxProvider"> {
  createSession(request: SandboxSessionCreateRequest): Promise<SandboxSession>;
  writeFiles(sessionId: string, files: readonly SandboxFile[]): Promise<void>;
  readFile(sessionId: string, path: string): Promise<string>;
  execute(sessionId: string, command: string, timeoutMs?: number): Promise<SandboxCommandResult>;
  closeSession(sessionId: string): Promise<void>;
}
export interface RepositoryProvider
  extends BaseProvider<"RepositoryProvider"> {}
export class ModelAliasResolutionError extends Error {
  constructor(alias: string) {
    super(`Model alias policy has no binding for alias: ${alias}`);
    this.name = "ModelAliasResolutionError";
  }
}

export class InvalidModelAliasError extends Error {
  constructor(alias: string) {
    super(`model_alias is not a recognized alias tier: ${alias}`);
    this.name = "InvalidModelAliasError";
  }
}

export interface ToolPermissionRequest {
  readonly tenantId: string;
  readonly toolName: string;
}

export interface ToolPermissionBinding {
  readonly allowed: boolean;
  readonly rateLimitPerMinute: number;
  readonly requiredScopes: readonly string[];
}

export interface CostLimitRequest {
  readonly tenantId: string;
  readonly runId: string;
}

export interface CostLimitBinding {
  readonly maxTokensPerCall: number;
  readonly maxCostUsdPerCall: number;
}

export interface ConfigProvider extends BaseProvider<"ConfigProvider"> {
  resolveModelAlias(alias: ModelAlias): Promise<ModelAliasBinding>;
  resolveToolPermission(
    request: ToolPermissionRequest,
  ): Promise<ToolPermissionBinding>;
  resolveCostLimit(request: CostLimitRequest): Promise<CostLimitBinding>;
}

export class ModelGatewayCostLimitExceededError extends Error {
  constructor(reason: string) {
    super(`Model invocation exceeded its resolved cost limit: ${reason}`);
    this.name = "ModelGatewayCostLimitExceededError";
  }
}

export class ModelGatewayInvalidResponseError extends Error {
  /**
   * Carried so a node failure can be classified rather than guessed at.
   *
   * NodeexecService puts this on `node_executions.error.code`, and
   * FailureClassifier scores `OUTPUT_INVALID` as a logic_output_failure --
   * which selects escalate_model, then replan, instead of the ask_user every
   * unclassified failure fell through to. A model answering in prose where
   * JSON was asked for is the textbook case for it (#149).
   */
  readonly code = "MODEL_OUTPUT_INVALID";

  constructor(reason: string) {
    super(`Model response failed validation: ${reason}`);
    this.name = "ModelGatewayInvalidResponseError";
  }
}
export interface RelationalDatabaseProvider
  extends BaseProvider<"RelationalDatabaseProvider"> {}
export interface VectorStoreProvider
  extends BaseProvider<"VectorStoreProvider"> {}
export interface SemanticCacheLookupRequest {
  readonly tenantId: string;
  readonly embedding: readonly number[];
  readonly similarityThreshold?: number;
  /**
   * Candidates outside this scope are never considered. Similarity alone
   * cannot tell apart two requests that merely share boilerplate, so a
   * caller puts everything that must match exactly -- the model, and the
   * fixed prompt around the varying content -- into the scope, and embeds
   * only what varies. Defaults to one shared scope per tenant.
   */
  readonly scope?: string;
}

export interface SemanticCacheLookupResult {
  readonly hit: boolean;
  readonly valueJson?: string;
  readonly similarity?: number;
}

export interface SemanticCacheStoreRequest {
  readonly tenantId: string;
  readonly embedding: readonly number[];
  readonly valueJson: string;
  readonly ttlSeconds?: number;
  /** The scope this candidate may be served from; see the lookup request. */
  readonly scope?: string;
}

export interface CacheProvider extends BaseProvider<"CacheProvider"> {
  getValue(key: string): Promise<string | undefined>;
  setValue(key: string, value: string, ttlSeconds: number): Promise<void>;
  deleteValue(key: string): Promise<void>;
  lookupSemantic(
    request: SemanticCacheLookupRequest,
  ): Promise<SemanticCacheLookupResult>;
  storeSemantic(request: SemanticCacheStoreRequest): Promise<void>;
}
export interface EventBusProvider extends BaseProvider<"EventBusProvider"> {}
export interface GPUComputeProvider
  extends BaseProvider<"GPUComputeProvider"> {}
export interface NetworkConnectivityProvider
  extends BaseProvider<"NetworkConnectivityProvider"> {}
