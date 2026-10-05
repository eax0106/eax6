import { Injectable } from "@nestjs/common";
import { TenantEngineActivitySchema, TenantBilledSpendSchema, type TenantActivityWindow } from "@alterx/contracts";
import type { EngineConfig } from "./config";
import type { EngineM2mTokenProvider } from "./auth";
import { EngineProblemError, upstreamProblem } from "./problem";

@Injectable()
export class TenantActivityClient {
  constructor(private readonly config: EngineConfig, private readonly m2m: EngineM2mTokenProvider, private readonly fetchImpl: typeof fetch = fetch) {}

  activity(window: TenantActivityWindow) {
    return this.read(this.config.baseUrl, "/internal/tenant-activity", window, TenantEngineActivitySchema.parse);
  }

  spend(window: TenantActivityWindow) {
    return this.read(this.config.costLedgerBaseUrl, "/internal/tenant-spend", window, TenantBilledSpendSchema.parse);
  }

  private requireWindow(actual: TenantActivityWindow, expected: TenantActivityWindow) {
    if (actual.tenant_id !== expected.tenant_id || actual.start_at !== expected.start_at || actual.end_at !== expected.end_at) throw new Error("Tenant activity response does not match its requested scope");
  }

  private async read<T extends TenantActivityWindow>(base: string, path: string, window: TenantActivityWindow, parse: (value: unknown) => T): Promise<T> {
    const instance = `/api/v1/admin/tenants/${window.tenant_id}/activity`;
    try {
      const token = await this.m2m.getAccessToken();
      const response = await this.fetchImpl(`${base.replace(/\/+$/, "")}${path}?${new URLSearchParams(window)}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
      if (!response.ok) throw new Error("Tenant activity service unavailable");
      const result = parse(await response.json());
      this.requireWindow(result, window);
      return result;
    } catch {
      throw new EngineProblemError(upstreamProblem(502, instance, "UPSTREAM_SERVICE_ERROR"));
    }
  }
}
