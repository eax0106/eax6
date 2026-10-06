import { z } from "./zod";
import { MissingConnectionSchema } from "./connection-registry";
import { WorkflowIdSchema, WorkflowVersionIdSchema } from "./ids";
import { WorkflowChatResourceSchema } from "./workflow-chat";

/** D18: Alter-authored starter templates held in the Capability Registry. */
export const WorkflowTemplateIdSchema = z.string().regex(/^[a-z][a-z0-9-]{2,63}$/);

export const WorkflowTemplateRequirementSchema = z.object({
  kind: z.enum(["connection", "documents", "whatsapp_account", "trigger", "setting"]),
  connector_type: z.string().nullable().optional(),
  purpose: z.string().min(1),
}).strict();

export const WorkflowTemplateSummarySchema = z.object({
  template_id: WorkflowTemplateIdSchema,
  version: z.number().int().positive(),
  title: z.string().min(1),
  summary: z.string().min(1),
  requirements: z.array(WorkflowTemplateRequirementSchema),
}).strict();

export const WorkflowTemplateTestCaseSchema = z.object({
  name: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  success_criteria: z.array(z.string().min(1)).min(1),
}).strict();

export const WorkflowTemplateSchema = WorkflowTemplateSummarySchema.extend({
  skeleton: z.record(z.string(), z.unknown()),
  test_cases: z.array(WorkflowTemplateTestCaseSchema).min(1),
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

/**
 * Instantiating creates a draft workflow and its chat. Passing workflowId
 * retries the compile for a workflow this template created earlier, once its
 * missing connections exist.
 */
export const InstantiateWorkflowTemplateRequestSchema = z.object({
  workflowId: WorkflowIdSchema.optional(),
}).strict();

export const InstantiateWorkflowTemplateResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("compiled"),
    templateId: WorkflowTemplateIdSchema,
    templateVersion: z.number().int().positive(),
    workflowId: WorkflowIdSchema,
    conversation: WorkflowChatResourceSchema,
    versionId: WorkflowVersionIdSchema,
  }).strict(),
  z.object({
    status: z.literal("connections_required"),
    templateId: WorkflowTemplateIdSchema,
    templateVersion: z.number().int().positive(),
    workflowId: WorkflowIdSchema,
    conversation: WorkflowChatResourceSchema,
    missingConnections: z.array(MissingConnectionSchema).min(1),
  }).strict(),
]);

export type WorkflowTemplateSummary = z.infer<typeof WorkflowTemplateSummarySchema>;
export type WorkflowTemplate = z.infer<typeof WorkflowTemplateSchema>;
export type InstantiateWorkflowTemplateRequest = z.infer<typeof InstantiateWorkflowTemplateRequestSchema>;
export type InstantiateWorkflowTemplateResult = z.infer<typeof InstantiateWorkflowTemplateResultSchema>;
