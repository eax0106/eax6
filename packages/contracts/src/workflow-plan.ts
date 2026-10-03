import { z } from "./zod";

export const SuccessCriteriaSchema = z.array(z.string().trim().min(1).max(1000)).max(100);

export const WorkflowPlanSchema = z.object({
  type: z.literal("plan"),
  successCriteria: SuccessCriteriaSchema,
  steps: z.array(z.object({
    key: z.string().min(1),
    type: z.string().min(1),
    description: z.string().min(1),
    successCriteria: SuccessCriteriaSchema,
  }).strict()).min(1).max(1000),
}).strict();

export const ConfirmWorkflowBuildSchema = z.object({
  confirm: z.literal(true),
  successCriteria: SuccessCriteriaSchema,
}).strict();

export type WorkflowPlan = z.infer<typeof WorkflowPlanSchema>;
