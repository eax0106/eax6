import { randomUUID, sign } from "node:crypto";
import { expect, it } from "vitest";
import { HostedFormSetupSchema } from "@alterx/contracts";
import { EngineClient } from "../engine/engine-client";
import { engineConfigFromEnvironment } from "../engine/config";
import type { EngineAuthProvider } from "../engine/auth";
import { TriggerService } from "./trigger.service";

const fixtureText = process.env.PUBLIC_FORM_AUTHOR_FIXTURE;
it.skipIf(!fixtureText)("uses the signed native engine for form authoring, scope, current-version edits and deployment changes", async () => {
  const fixture = JSON.parse(fixtureText!);
  const jwt = (claims: Record<string, unknown>) => {
    const input = [{ alg: "RS256", kid: "form-native" }, claims].map(part => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".");
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), fixture.privateKey).toString("base64url")}`;
  };
  const authorization: EngineAuthProvider = { authorize: async context => {
    const now = Math.floor(Date.now() / 1000);
    return { m2mAccessToken: jwt({ iss: "https://auth.test/", aud: "alter-engine", iat: now, exp: now + 60 }), actorToken: jwt({
      user_id: context.userId, tenant_id: context.tenantId, workspace_id: context.workspaceId, roles: context.roles, permissions: context.permissions,
      session_id: context.sessionId, auth_time: now, jti: randomUUID(), iss: "alter-platform-api.identity-broker", aud: "alter-engine", iat: now, exp: now + 60,
    }) };
  } };
  const config = engineConfigFromEnvironment({ ENGINE_BASE_URL: fixture.baseUrl, ADS_CORE_BASE_URL: fixture.baseUrl, COST_LEDGER_BASE_URL: fixture.baseUrl, AUDIT_SERVICE_BASE_URL: fixture.baseUrl,
    EVAL_FACADE_TOKEN_REF: "native", DEPLOYMENT_ADMIN_SERVICE_TOKEN_REF: "native", AUDIT_QUERY_SERVICE_TOKEN_REF: "native", ENGINE_M2M_TOKEN_URL: `${fixture.baseUrl}/token`, ENGINE_M2M_AUDIENCE: "alter-engine", ENGINE_M2M_CLIENT_ID: "native", ENGINE_M2M_CLIENT_SECRET_REF: "native" });
  const service = new TriggerService(new EngineClient(config, authorization));
  const actor = { user_id: fixture.actor, tenant_id: fixture.tenant, workspace_id: fixture.workspace, roles: ["admin"], permissions: ["workflows:read", "workflows:write", "workflows:deploy"], session_id: "native-form", auth_time: Math.floor(Date.now() / 1000) };
  const definition = { title: "Native platform form", fields: [{ name: "email", label: "Email", type: "email", required: true }] };
  const created = await service.create({ workflowId: fixture.workflow, workflowVersionId: fixture.workflowVersion, workspaceId: fixture.workspace, name: definition.title, type: "webhook", provider: "alter_public_form", config: { publicForm: definition } }, actor, undefined, randomUUID());
  const id = created.body.trigger.id;
  const initial = HostedFormSetupSchema.parse((await service.publicForm(id, actor, undefined)).body);
  expect(initial).toMatchObject({ definition, status: "draft", version: 1 });
  for (const foreign of [{ ...actor, workspace_id: "ws_018f47a5-7b2c-7d10-8f11-123456789abc" }, { ...actor, tenant_id: "ten_018f47a5-7b2c-7d10-8f11-123456789abc" }]) {
    await expect(service.publicForm(id, foreign, undefined)).rejects.toMatchObject({ problem: { status: 404 } });
    await expect(service.createVersion(id, { config: { publicForm: definition } }, foreign, undefined, randomUUID(), initial.etag)).rejects.toMatchObject({ problem: { status: 404 } });
  }
  await expect(service.createVersion(id, { config: { publicForm: definition } }, actor, undefined, randomUUID())).rejects.toMatchObject({ problem: { status: 428 } });
  await service.createVersion(id, { config: { publicForm: { ...definition, title: "Updated native form" } } }, actor, undefined, randomUUID(), initial.etag);
  await expect(service.createVersion(id, { config: { publicForm: definition } }, actor, undefined, randomUUID(), initial.etag)).rejects.toMatchObject({ problem: { status: 412 } });
  const changed = HostedFormSetupSchema.parse((await service.publicForm(id, actor, undefined)).body);
  expect(changed).toMatchObject({ version: 2, definition: { title: "Updated native form" } });
  expect(changed.publicUrl).not.toBe(initial.publicUrl);
  await service.setPublicFormStatus(id, { status: "enabled" }, actor, undefined, randomUUID(), changed.etag);
  await expect(service.setPublicFormStatus(id, { status: "disabled" }, actor, undefined, randomUUID(), changed.etag)).rejects.toMatchObject({ problem: { status: 412 } });
  const enabled = HostedFormSetupSchema.parse((await service.publicForm(id, actor, undefined)).body);
  await service.setPublicFormStatus(id, { status: "disabled" }, actor, undefined, randomUUID(), enabled.etag);
  expect(HostedFormSetupSchema.parse((await service.publicForm(id, actor, undefined)).body).status).toBe("disabled");
});
