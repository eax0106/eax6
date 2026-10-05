export function creditPurchaseConfigFromEnvironment(environment: NodeJS.ProcessEnv) {
  return { databaseUrl: environment.DATABASE_URL, region: environment.AWS_REGION ?? "ap-south-1",
    keyIdSecretRef: environment.RAZORPAY_KEY_ID_SECRET_REF ?? "/alter/billing/razorpay/key-id",
    keySecretSecretRef: environment.RAZORPAY_KEY_SECRET_SECRET_REF ?? "/alter/billing/razorpay/key-secret" };
}
