import { resolveEnvironmentSecret } from "@alterx/shared-clients";

export class BillingPolicyClient {
  constructor(private readonly baseUrl: string, private readonly resolveToken: () => Promise<string>, private readonly fetchImpl: typeof fetch=fetch) {}
  async policy(payload: unknown): Promise<void> { await this.send("policy",payload); }
  async grant(tenantId: string,eventRef: string,credits: number): Promise<void> {
    const ack=await this.send("grant",{tenantId:`ten_${tenantId}`,eventRef,credits});
    if(!ack||typeof ack!=="object"||!("applied" in ack)||typeof ack.applied!=="boolean")throw new Error("Billing credit grant acknowledgement is invalid");
  }
  async account(tenantId: string): Promise<{balance:string;reserved:string;available:string}> {
    return await this.send("account",{tenantId:`ten_${tenantId}`}) as {balance:string;reserved:string;available:string};
  }
  private async send(route: string,body: unknown): Promise<unknown> {
    const token=await this.resolveToken();if(!token)throw new Error("Billing synchronization authentication unavailable");
    const response=await this.fetchImpl(`${this.baseUrl.replace(/\/+$/,"")}/internal/billing/${route}`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw new Error(`Billing synchronization failed (${response.status})`);
    return response.json();
  }
}
export function billingPolicyClientFromEnvironment(environment: NodeJS.ProcessEnv=process.env): BillingPolicyClient | undefined {
  if(!environment.ENGINE_BASE_URL)return undefined;
  const reference=environment.BILLING_SYNC_SERVICE_TOKEN_REF;
  if(!reference)throw new Error("BILLING_SYNC_SERVICE_TOKEN_REF required with engine URL");
  return new BillingPolicyClient(environment.ENGINE_BASE_URL,async()=>resolveEnvironmentSecret(reference,environment));
}

export function billingPolicyDependenciesFromEnvironment(environment: NodeJS.ProcessEnv=process.env) {
  return {databaseUrl: environment.DATABASE_URL, client: billingPolicyClientFromEnvironment(environment)};
}
