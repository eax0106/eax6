import type { EmailProvider } from "@alterx/shared-clients";
import { MockEmailProvider } from "./mock-email-provider";
import { SesEmailProvider, type SecretResolver } from "./ses-email-provider";

// ENGINE-FIX-P3-17: relocated here from
// apps/platform-api/src/notifications/notification.module.ts so every
// service that needs a real EmailProvider (platform-api's notification
// module, tool-gateway's email.send tool action) resolves it identically
// instead of each hand-rolling its own copy of this same env-var-switch +
// mock-in-production-is-fatal logic -- exactly the kind of duplicated
// environment-validation logic this repo's own audit history already
// flagged as tech debt.
//
// Originally: was raw SES_FROM_ADDRESS/SES_CREDENTIALS_SECRET_REF presence
// sniffing -- both vars absent fell through to MockEmailProvider silently
// in any environment including production, with no fatal check at all.
// EMAIL_PROVIDER drives an explicit switch instead: "ses" missing its
// paired config throws instead of silently downgrading; mock is fatal
// when NODE_ENV=production.
//
// Takes the secret resolver as a parameter (matching SesEmailProvider's
// own constructor) rather than importing one service's own secret-
// resolution helper directly -- platform-api's is identity.module.ts's
// resolveRuntimeSecret, tool-gateway has no equivalent of that module at
// all (it resolves secrets through its own injected SecretsProvider
// instead) -- so this stays portable across services with no
// platform-api-specific dependency, and neither service duplicates the
// other's secret-resolution mechanism.
export function resolveEmailProvider(resolveSecret: SecretResolver, environment = process.env): EmailProvider {
  const provider = environment.EMAIL_PROVIDER ?? "mock";
  if (provider === "ses") {
    const fromAddress = environment.SES_FROM_ADDRESS;
    const credentialsSecretRef = environment.SES_CREDENTIALS_SECRET_REF;
    if (!fromAddress || !credentialsSecretRef) {
      throw new Error(
        "SES_FROM_ADDRESS and SES_CREDENTIALS_SECRET_REF are required when EMAIL_PROVIDER=ses",
      );
    }
    return new SesEmailProvider(
      {
        region: environment.AWS_REGION ?? "ap-south-1",
        fromAddress,
        credentialsSecretRef,
        ...(environment.SES_CONFIGURATION_SET_NAME ? { configurationSetName: environment.SES_CONFIGURATION_SET_NAME } : {}),
      },
      resolveSecret,
    );
  }

  if (environment.NODE_ENV === "production") {
    throw new Error("EMAIL_PROVIDER=mock is not allowed when NODE_ENV=production");
  }
  return new MockEmailProvider();
}
