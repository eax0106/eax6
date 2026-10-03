import { z } from "./zod";
import { ConversationIdSchema, UserIdSchema, WorkflowIdSchema, prefixedUuidV7 } from "./ids";

export const WorkflowChatResourceSchema = z.object({
  id: ConversationIdSchema,
  title: z.string().min(1),
  type: z.enum(["general", "workflow_builder", "project_builder", "run_investigation"]),
  status: z.enum(["active", "archived"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  createdBy: z.object({ id: UserIdSchema, name: z.string().optional() }).strict().optional(),
  linkedWorkflowId: WorkflowIdSchema.optional(),
  preview: z.string().optional(),
}).strict();

export const WorkflowChatMessageSchema = z.object({
  id: prefixedUuidV7("msg"),
  conversationId: ConversationIdSchema,
  role: z.enum(["user", "assistant", "system"]),
  kind: z.enum(["text", "clarification", "workflow", "project", "run", "artifact", "action"]),
  content: z.union([z.string(), z.record(z.string(), z.unknown())]),
  createdAt: z.string().datetime(),
}).strict();

export const CreateWorkflowChatRequestSchema = z.object({
  type: z.enum(["general", "workflow_builder"]),
  title: z.string().trim().min(1).max(160),
  linkedWorkflowId: WorkflowIdSchema.optional(),
}).strict().refine(value => value.type !== "general" || value.linkedWorkflowId === undefined,
  "Ask Alter cannot be linked to an existing workflow");

export const SendWorkflowChatMessageSchema = z.object({
  content: z.string().trim().min(1).max(16000),
  kind: z.literal("text").optional(),
}).strict();

export const WorkflowChatExchangeSchema = z.object({
  userMessage: WorkflowChatMessageSchema,
  assistantMessage: WorkflowChatMessageSchema.optional(),
}).strict();

export const WorkflowChatBeginSchema = z.object({
  conversation: WorkflowChatResourceSchema,
  userMessage: WorkflowChatMessageSchema,
  messages: z.array(WorkflowChatMessageSchema),
}).strict();

export type WorkflowChatResource = z.infer<typeof WorkflowChatResourceSchema>;
export type WorkflowChatMessage = z.infer<typeof WorkflowChatMessageSchema>;
export type CreateWorkflowChatRequest = z.infer<typeof CreateWorkflowChatRequestSchema>;
export type SendWorkflowChatMessage = z.infer<typeof SendWorkflowChatMessageSchema>;
export type WorkflowChatExchange = z.infer<typeof WorkflowChatExchangeSchema>;
export type WorkflowChatBegin = z.infer<typeof WorkflowChatBeginSchema>;
