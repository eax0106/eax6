import {
  InstantiateWorkflowTemplateResultSchema, WorkflowTemplateSummarySchema,
  type InstantiateWorkflowTemplateResult, type WorkflowTemplateSummary,
} from "@alterx/contracts"
import { apiGet, apiPost, isLiveApi, mutationKey } from "../http"
import { delay } from "../mock/data"

// D18: Alter-authored starter templates from the Capability Registry. Using
// one creates a draft workflow and its chat; nothing is activated or run.

// Demo mode has no registry; these mirror the titles and summaries of the
// reviewed set so the first-run screen can be tried.
const demoTemplates: WorkflowTemplateSummary[] = [
  ["lead-capture-crm-welcome", "Lead capture to CRM with a welcome email", "A new lead from a form is checked, saved to your CRM table once per email address, and sent a short welcome email.", "connection"],
  ["support-email-triage", "Support email triage, label and route", "Each incoming support email gets one label and urgency and is forwarded to the matching team inbox; unclear requests go to an escalation inbox.", "trigger"],
  ["invoice-email-to-sheet", "Invoice email to a sheet row", "Details are extracted from an emailed invoice, the amounts are checked, and one row is added to your invoices table; incomplete or inconsistent invoices are held for review.", "connection"],
  ["weekly-report-digest", "Weekly report digest by email", "The week's records sent by your reporting system are counted and totalled by type and emailed as a short digest; a week with no activity says so.", "trigger"],
  ["knowledge-qa", "Knowledge Q&A over your documents", "A question is answered only from your workspace's uploaded documents (and any text attached to the question), with the sources named; when the documents do not say, the answer says so.", "documents"],
  ["meeting-notes-summary", "Meeting notes to a summary email with action items", "Meeting notes become a short summary email listing the decisions and the action items with their owners and due dates, keeping unknown owners and dates unknown.", "trigger"],
  ["brand-mention-alert", "Brand mention monitoring with an alert", "New mentions of your brand, from your monitoring feed and a web search, are checked for relevance and de-duplicated; genuine new mentions are emailed as one alert naming each mention's feed id.", "trigger"],
  ["whatsapp-faq-responder", "WhatsApp FAQ responder", "Incoming WhatsApp questions are answered from your FAQ documents and replied to on WhatsApp; anything the FAQ does not cover is passed to your team by email instead of guessed.", "whatsapp_account"],
].map(([template_id, title, summary, kind]) => ({
  template_id: template_id!, version: 1, title: title!, summary: summary!,
  requirements: [{ kind: kind as WorkflowTemplateSummary["requirements"][number]["kind"], purpose: "Shown in the live product." }],
}))

export const workflowTemplatesService = {
  async list(): Promise<WorkflowTemplateSummary[]> {
    if (isLiveApi) return WorkflowTemplateSummarySchema.array().parse(await apiGet("/api/v1/workflow-templates"))
    await delay(150)
    return demoTemplates
  },

  async instantiate(templateId: string, workflowId?: string): Promise<InstantiateWorkflowTemplateResult> {
    if (isLiveApi) {
      return InstantiateWorkflowTemplateResultSchema.parse(await apiPost(`/api/v1/workflow-templates/${encodeURIComponent(templateId)}/instantiate`,
        workflowId === undefined ? {} : { workflowId }, { idempotencyKey: mutationKey("template-instantiate") }))
    }
    await delay(300)
    const template = demoTemplates.find(item => item.template_id === templateId)
    if (!template) throw new Error("Template not found")
    // Imported here: the client module itself imports the service modules.
    const { api } = await import("../client")
    const conversation = await api.createConversation({ type: "workflow_builder", title: template.title })
    return { status: "compiled", templateId, templateVersion: template.version, workflowId: conversation.linkedWorkflowId!, conversation: conversation as never,
      versionId: "wfv_00000000-0000-7000-8000-000000000000" }
  },
}
