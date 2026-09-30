import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MockEmailProvider } from "@alterx/adapters";
import { describe, expect, it, vi } from "vitest";
import { supportedLocales } from "../i18n/types";
import { NotificationService } from "./notification.service";
import type { NotificationRepository } from "./notification.repository";
import { notificationEventClasses, type NotificationEvent } from "./types";

type Template = { TemplateName: string; TemplateContent: { Subject: string; Text: string; Html?: string } };
const registrationUrl = pathToFileURL(resolve(process.cwd(), "deploy/ec2/register-notification-email-templates.mjs")).href;
const templates: Template[] = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `import {notificationEmailTemplates} from ${JSON.stringify(registrationUrl)}; console.log(JSON.stringify(notificationEmailTemplates()));`], { encoding: "utf8" }));
const now = new Date("2026-09-30T10:00:00.000Z");
function render(template: string, variables: Record<string, string>) {
  return template.replace(/{{([a-z_]+)}}/g, (_match, key: string) => {
    if (variables[key] === undefined) throw new Error(`missing template variable: ${key}`);
    return variables[key];
  });
}
function setup() {
  const email = new MockEmailProvider(() => now);
  const repository = {
    preferenceEnabled: vi.fn().mockResolvedValue(true),
    emailDeliveryPreference: vi.fn().mockResolvedValue({ enabled: true, deliveryMode: "immediate" }),
    createEvent: vi.fn(async (id: string, input: Record<string, unknown>) => ({ ...input, id, createdAt: now.toISOString(), readAt: null, acknowledgedAt: null }) as NotificationEvent),
    findUserEmail: vi.fn().mockResolvedValue("recipient@example.test"),
    listDigestCandidates: vi.fn(), reserveDigest: vi.fn().mockResolvedValue("digest-1"),
    markDigestSent: vi.fn(), releaseDigest: vi.fn(),
  };
  return { email, repository, service: new NotificationService(repository as unknown as NotificationRepository, email) };
}
describe("notification email templates", () => {
  it("covers exactly every production class and supported locale, plus digest", () => {
    const names = [undefined, ...supportedLocales].flatMap((locale) => [...notificationEventClasses, "digest"].map((kind) => `notification-${kind}${locale ? `-${locale}` : ""}`));
    expect(templates.map((template) => template.TemplateName).sort()).toEqual(names.sort());
    expect(new Set(names).size).toBe(names.length);
  });
  for (const eventClass of notificationEventClasses) {
    it.each([undefined, ...supportedLocales])(`renders the real ${eventClass} payload in locale %s through the mock adapter`, async (locale) => {
      const { service, email } = setup();
      await service.createEvent({ tenantId: "tenant-test", workspaceId: "workspace-test", userId: "user-test", eventClass, severity: "warning", title: "Workflow <title>", body: "Text & literal <script> stays plain text", deepLink: "/app/workflows/wf_test", sourceService: "platform-api.engine-events", ...(locale ? { locale } : {}) });
      expect(email.sent).toHaveLength(1);
      const sent = email.sent[0]!;
      const name = `${sent.templateId}${sent.locale ? `-${sent.locale}` : ""}`;
      const template = templates.find((item) => item.TemplateName === name);
      expect(template, `missing deployed template ${name}`).toBeDefined();
      expect(template!.TemplateContent.Html).toBeUndefined();
      const text = render(template!.TemplateContent.Text, sent.variables);
      expect(text).toContain("Text & literal <script> stays plain text");
      expect(text).toContain("/app/workflows/wf_test");
      expect(render(template!.TemplateContent.Subject, sent.variables)).toBe("Alter: Workflow <title>");
    });
  }
  it("renders the real digest as readable notifications instead of raw JSON", async () => {
    const { service, email, repository } = setup();
    repository.listDigestCandidates.mockResolvedValueOnce([{ id: "evt_test", event_class: "workflow", severity: "info", title: "Version 3 is live", body: "Workflow deployment changed", deep_link: "/app/workflows/wf_test", created_at: now, email: "recipient@example.test" }]);
    await expect(service.buildDigest({ tenantId: "tenant-test", userId: "user-test", periodStart: new Date("2026-09-29T10:00:00Z"), periodEnd: now })).resolves.toEqual({ sent: true, eventCount: 1 });
    const sent = email.sent[0]!;
    const template = templates.find((item) => item.TemplateName === sent.templateId)!;
    const rendered = render(template.TemplateContent.Text, sent.variables);
    expect(rendered).toContain("Version 3 is live\nWorkflow deployment changed\n/app/workflows/wf_test");
    expect(rendered).not.toContain('"event_class"');
    expect(repository.markDigestSent).toHaveBeenCalled();
  });
  it("defaults registration to a no-write dry run", () => {
    const output = execFileSync(process.execPath, ["deploy/ec2/register-notification-email-templates.mjs"], { encoding: "utf8" });
    expect(output).toContain("notification-templates-dry-run-ok: 21; no AWS call made");
  });
  it("creates missing templates, updates existing ones and stops on non-missing lookup errors", () => {
    const script = `
      import assert from 'node:assert/strict';
      import {registerNotificationEmailTemplates} from ${JSON.stringify(registrationUrl)};
      const templates = [{TemplateName:'existing',TemplateContent:{Subject:'s',Text:'t'}},{TemplateName:'missing',TemplateContent:{Subject:'s',Text:'t'}}];
      const calls=[];
      registerNotificationEmailTemplates(templates,args=>{calls.push(args);if(args[1]==='get-email-template' && args[3]==='missing')throw {stderr:'NotFoundException'};});
      assert.deepEqual(calls.map(args=>args[1]),['get-email-template','update-email-template','get-email-template','create-email-template']);
      assert.deepEqual(JSON.parse(calls[3][3]),templates[1]);
      assert.throws(()=>registerNotificationEmailTemplates(templates,()=>{throw {stderr:'AccessDeniedException'};}),/lookup failed/);
      console.log('registration-controls-ok');`;
    expect(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" })).toContain("registration-controls-ok");
  });
});
