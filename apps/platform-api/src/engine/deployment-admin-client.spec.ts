import { describe, expect, it, vi } from "vitest";
import { DeploymentAdminClient } from "./deployment-admin-client";
import type { EngineConfig } from "./config";

const config: EngineConfig = {
  baseUrl: "https://engine.test",
  adsCoreBaseUrl: "https://ads.test",
  costLedgerBaseUrl: "https://cost.test",
  evalFacadeTokenRef: "env:EVAL",
  deploymentAdminServiceTokenRef: "env:DEPLOYMENT_ADMIN",
  auditServiceBaseUrl: "https://audit.test",
  auditQueryServiceTokenRef: "env:AUDIT",
  m2mTokenUrl: "https://identity.test/token",
  m2mAudience: "engine",
  m2mClientId: "platform",
  m2mClientSecretRef: "env:M2M",
  requestTimeoutMs: 5000,
  planningTimeoutMs: 120_000,
};
const input = {
  tenant_id: "018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
  deployment_id: "dep_018f4d6e-2b4a-7a3e-8c1a-1234567890a2",
  action: "suspend" as const,
  reason: "incident",
};

describe("DeploymentAdminClient", () => {
  it("resolves credential and calls authenticated internal HTTP route", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      tenant_id: input.tenant_id,
      deployment_id: input.deployment_id,
      action: input.action,
      project_id: "prj_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
      status: "suspended",
      active_deployment_id: null,
      updated_at: "2026-08-06T12:00:00.000Z",
      etag:`"${input.deployment_id}:rev-2"`,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const resolveSecret = vi.fn().mockResolvedValue("real-secret");
    const client = new DeploymentAdminClient(config, resolveSecret, fetchImpl);
    await expect(client.apply(input,"stf_admin",`"${input.deployment_id}:rev-1"`, "00-trace-parent")).resolves.toMatchObject({ status: "suspended" });
    expect(resolveSecret).toHaveBeenCalledWith("env:DEPLOYMENT_ADMIN");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://engine.test/internal/admin/deployments/actions/apply",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer real-secret",
          traceparent: "00-trace-parent",
          "If-Match":`"${input.deployment_id}:rev-1"`,
        }),
      }),
    );
  });

  it("rejects malformed successful upstream response", async () => {
    const client = new DeploymentAdminClient(config, async () => "secret", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "suspended" }), { status: 200 }),
    ));
    await expect(client.apply(input,"stf_admin",`"${input.deployment_id}:rev-1"`, undefined)).rejects.toMatchObject({ response: expect.objectContaining({ status: 502 }) });
  });

  it("maps internal credential rejection to upstream failure", async () => {
    const client = new DeploymentAdminClient(config, async () => "stale", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 401 }), { status: 401 }),
    ));
    await expect(client.apply(input,"stf_admin",`"${input.deployment_id}:rev-1"`, undefined)).rejects.toMatchObject({
      response: expect.objectContaining({ status: 502, error_code: "UPSTREAM_SERVICE_ERROR" }),
    });
  });

  it("maps secret resolution and ordinary upstream failures", async () => {
    const unavailableSecret = new DeploymentAdminClient(config, async () => {
      throw new Error("secret store unavailable");
    });
    await expect(unavailableSecret.apply(input,"stf_admin",`"${input.deployment_id}:rev-1"`, undefined)).rejects.toMatchObject({
      response: expect.objectContaining({ status: 502, error_code: "UPSTREAM_SERVICE_ERROR" }),
    });

    const rejected = new DeploymentAdminClient(config, async () => "secret", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        type: "https://errors.alter.ai/validation-error",
        title: "VALIDATION_ERROR",
        status: 400,
        detail: "invalid deployment state",
        instance: "/wrong",
        error_code: "VALIDATION_ERROR",
        trace_id: "trc_1",
        request_id: "req_1",
        retryable: false,
        field_errors: [],
        documentation_key: "validation.error",
      }), { status: 400, headers: { "content-type": "application/problem+json" } }),
    ));
    await expect(rejected.apply(input,"stf_admin",`"${input.deployment_id}:rev-1"`, undefined)).rejects.toMatchObject({
      response: expect.objectContaining({ status: 400, error_code: "UPSTREAM_SERVICE_ERROR" }),
    });
  });

  it("maps an aborted request to an upstream timeout", async () => {
    const abortError = Object.assign(new Error("deadline exceeded"), { name: "AbortError" });
    const client = new DeploymentAdminClient(config, async () => "secret", vi.fn().mockRejectedValue(abortError));

    await expect(client.apply(input,"stf_admin",`"${input.deployment_id}:rev-1"`, undefined)).rejects.toMatchObject({
      response: expect.objectContaining({ status: 504, error_code: "UPSTREAM_TIMEOUT" }),
    });
  });
});

describe("deployment collection and acknowledgement failures",()=>{
 const etag=`"${input.deployment_id}:rev-1"`,other="018f4d6e-2b4a-7a3e-8c1a-1234567890ac";
 it("reads a genuinely empty collection with the dedicated credential and trace",async()=>{
  const fetchImpl=vi.fn().mockResolvedValue(Response.json({tenant_id:input.tenant_id,total:0,items:[]}));
  expect(await new DeploymentAdminClient(config,async()=>"native-only-credential",fetchImpl).list(input.tenant_id,"00-native-trace")).toEqual({tenant_id:input.tenant_id,total:0,items:[]});
  expect(fetchImpl).toHaveBeenCalledWith(`https://engine.test/internal/admin/deployments?tenant_id=${input.tenant_id}`,expect.objectContaining({headers:expect.objectContaining({Authorization:"Bearer native-only-credential",traceparent:"00-native-trace"})}));
 });
 it.each(["", "   "])("refuses an unavailable credential before list or mutation transport %#",async credential=>{
  const fetchImpl=vi.fn(),client=new DeploymentAdminClient(config,async()=>credential,fetchImpl);
  await expect(client.list(input.tenant_id,undefined)).rejects.toMatchObject({response:{status:502}});await expect(client.apply(input,"stf_admin",etag,undefined)).rejects.toMatchObject({response:{status:502}});expect(fetchImpl).not.toHaveBeenCalled();
 });
 it("maps failed list credential resolution and service rejection",async()=>{
  const unresolved=new DeploymentAdminClient(config,async()=>{throw new Error("Credential store unavailable")});await expect(unresolved.list(input.tenant_id,undefined)).rejects.toMatchObject({response:{status:502}});
  const rejected=new DeploymentAdminClient(config,async()=>"native-only",vi.fn().mockResolvedValue(Response.json({detail:"Engine unavailable"},{status:503})));await expect(rejected.list(input.tenant_id,undefined)).rejects.toMatchObject({response:{error_code:"UPSTREAM_SERVICE_ERROR"}});
 });
 it.each([{tenant_id:other,total:0,items:[]},{tenant_id:input.tenant_id,total:-1,items:[]},[]])("rejects malformed or differently scoped successful list %#",async body=>{
  const client=new DeploymentAdminClient(config,async()=>"native-only",vi.fn().mockResolvedValue(Response.json(body)));await expect(client.list(input.tenant_id,undefined)).rejects.toMatchObject({response:{status:502}});
 });
 it("maps malformed JSON and ordinary fetch failures explicitly",async()=>{
  const malformed=new DeploymentAdminClient(config,async()=>"native-only",vi.fn().mockResolvedValue(new Response("invalid-json")));await expect(malformed.list(input.tenant_id,undefined)).rejects.toMatchObject({response:{status:502}});
  const network=new DeploymentAdminClient(config,async()=>"native-only",vi.fn().mockRejectedValue(new Error("Transport unavailable")));await expect(network.list(input.tenant_id,undefined)).rejects.toMatchObject({response:{status:502}});await expect(network.apply(input,"stf_admin",etag,undefined)).rejects.toMatchObject({response:{status:502}});
 });
 it("aborts list and action at their actual configured deadline",async()=>{
  const fetchImpl=vi.fn((_url:Parameters<typeof fetch>[0],init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{const signal=init!.signal!;signal.addEventListener("abort",()=>reject(signal.reason),{once:true});}));
  const client=new DeploymentAdminClient({...config,requestTimeoutMs:20},async()=>"native-only",fetchImpl);
  await expect(client.list(input.tenant_id,undefined)).rejects.toMatchObject({response:{status:504}});await expect(client.apply(input,"stf_admin",etag,undefined)).rejects.toMatchObject({response:{status:504,error_code:"UPSTREAM_TIMEOUT"}});expect(fetchImpl.mock.calls.every(([,init])=>init?.signal?.aborted)).toBe(true);
 });
 it.each([{tenant_id:other},{deployment_id:"dep_018f4d6e-2b4a-7a3e-8c1a-1234567890a3"},{action:"resume"},{etag:undefined}])("rejects unbound or unversioned action acknowledgement %#",async override=>{
  const body={tenant_id:input.tenant_id,deployment_id:input.deployment_id,project_id:"prj_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",action:input.action,status:"suspended",active_deployment_id:null,updated_at:"2026-10-05T00:00:00Z",etag:`"${input.deployment_id}:rev-2"`,...override};
  await expect(new DeploymentAdminClient(config,async()=>"native-only",vi.fn().mockResolvedValue(Response.json(body))).apply(input,"stf_admin",undefined,undefined)).rejects.toMatchObject({response:{status:502}});
 });
});
