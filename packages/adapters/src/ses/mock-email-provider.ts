import type { ProviderCapabilities } from "@alterx/contracts";
import type {
  EmailProvider,
  EmailSendResult,
  ProviderHealth,
  ProviderMetadata,
} from "@alterx/shared-clients";
import { SES_EMAIL_CAPABILITIES } from "./ses-email-provider";

export class MockEmailProvider implements EmailProvider {
  readonly metadata: ProviderMetadata<"EmailProvider"> = {
    providerId: "mock-email",
    interfaceName: "EmailProvider",
    displayName: "Mock Email",
    version: "test-v1",
    telemetryNamespace: "alterx.adapters.ses.mock",
    supportsTenantOverrides: false,
    migration: { strategyVersion: "mock-email-v1", rollbackSupported: true },
  };
  readonly capabilities: ProviderCapabilities = SES_EMAIL_CAPABILITIES;
  readonly sent: Array<{
    readonly to: string;
    readonly templateId: string;
    readonly variables: Record<string, string>;
    readonly locale: string | undefined;
  }> = [];
  readonly sentRaw: Array<{
    readonly to: string;
    readonly subject: string;
    readonly body: string;
    readonly html: boolean | undefined;
  }> = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  async sendTemplatedEmail(
    to: string,
    templateId: string,
    variables: Record<string, string>,
    locale?: string,
  ): Promise<EmailSendResult> {
    this.sent.push({ to, templateId, variables: { ...variables }, locale });
    return {
      messageId: `mock-email-${this.sent.length}`,
      acceptedAt: this.now().toISOString(),
    };
  }

  async sendEmail(
    to: string,
    subject: string,
    body: string,
    options?: { readonly html?: boolean; readonly tenantId?: string },
  ): Promise<EmailSendResult> {
    this.sentRaw.push({ to, subject, body, html: options?.html });
    return {
      messageId: `mock-email-${this.sentRaw.length}`,
      acceptedAt: this.now().toISOString(),
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      status: "healthy",
      checkedAt: this.now().toISOString(),
      latencyMs: 0,
      details: { configured: true },
    };
  }
}
