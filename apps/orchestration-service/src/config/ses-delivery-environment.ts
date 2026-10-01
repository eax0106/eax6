export interface SesDeliveryEnvironment {
  readonly webhookSecret: string | undefined;
}

export const SES_DELIVERY_ENVIRONMENT = Symbol("SES_DELIVERY_ENVIRONMENT");

export function loadSesDeliveryEnvironment(environment: NodeJS.ProcessEnv): SesDeliveryEnvironment {
  const value = environment.SES_EVENT_WEBHOOK_SECRET?.trim();
  return { webhookSecret: value === undefined || value.length === 0 ? undefined : value };
}
