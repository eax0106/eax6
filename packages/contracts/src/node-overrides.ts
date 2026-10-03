import { z } from "./zod";
import { ModelAliasSchema } from "./model-alias-policy";
import { ToolNameSchema } from "./tool-names";

export const NodeOverrideChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("model"), value: ModelAliasSchema }).strict(),
  z.object({ kind: z.literal("tool"), value: ToolNameSchema }).strict(),
]);
export type NodeOverrideChoice = z.infer<typeof NodeOverrideChoiceSchema>;

export const NodeOverrideThresholdsSchema = z.object({
  costIncreaseRatio: z.number().finite().nonnegative().default(0.25),
  costIncreaseMinor: z.number().int().nonnegative().default(500),
  latencyMultiplier: z.number().finite().min(1).default(2),
}).strict();
export type NodeOverrideThresholds = z.infer<typeof NodeOverrideThresholdsSchema>;

/** Declared port types, including required object fields and array items. */
export interface DataContract {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, DataContract> | undefined;
  required?: string[] | undefined;
  items?: DataContract | undefined;
}
export const DataContractSchema: z.ZodType<DataContract> = z.lazy(() => z.object({
  type: z.enum(["object", "array", "string", "number", "integer", "boolean", "null"]),
  properties: z.record(z.string().min(1), DataContractSchema).optional(),
  required: z.array(z.string().min(1)).max(1000).optional(),
  items: DataContractSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.properties !== undefined || value.required !== undefined) && value.type !== "object") ctx.addIssue({code:"custom",message:"Only object contracts declare properties or required fields"});
  if (value.items !== undefined && value.type !== "array") ctx.addIssue({code:"custom",message:"Only array contracts declare items"});
  for (const key of value.required ?? []) if (value.properties?.[key] === undefined) ctx.addIssue({code:"custom",message:`Required field has no declared type: ${key}`});
}));

/** True only when every output allowed by the declared type fits the input. */
export function dataContractFits(output: DataContract, input: DataContract): boolean {
  if (output.type !== input.type && !(output.type === "integer" && input.type === "number")) return false;
  if (input.type === "array" && input.items) return output.items !== undefined && dataContractFits(output.items, input.items);
  if (input.type !== "object") return true;
  for (const key of input.required ?? []) if (!output.required?.includes(key)) return false;
  for (const [key, expected] of Object.entries(input.properties ?? {})) {
    const supplied = output.properties?.[key];
    if (supplied && !dataContractFits(supplied, expected)) return false;
    if (!supplied && input.required?.includes(key)) return false;
  }
  return true;
}

export const NodeSelectionEvidenceSchema = z.object({
  binding: z.object({
    record_id: z.string().min(1).max(128), version: z.number().int().positive(),
    kind: z.enum(["agent", "model", "tool", "connector", "execution"]),
    rationale: z.string().min(1), score: z.number().min(0).max(1),
    factors: z.record(z.string().min(1), z.number().finite()),
  }).strict(),
  policy: z.object({reliability_weight:z.number().min(0).max(1),latency_weight:z.number().min(0).max(1),cost_weight:z.number().min(0).max(1)}).strict().refine(value => value.reliability_weight + value.latency_weight + value.cost_weight > 0, "At least one score weight must be positive").optional(),
  required_capabilities: z.array(z.string().min(1)).max(128),
  required_model_alias: ModelAliasSchema.optional(),
  model_alias: ModelAliasSchema.optional(), tool_name: ToolNameSchema.optional(),
}).strict();
export type NodeSelectionEvidence = z.infer<typeof NodeSelectionEvidenceSchema>;

export function applyNodeOverride(config: Record<string, unknown>, choice: NodeOverrideChoice): Record<string, unknown> {
  return choice.kind === "model" ? {...config, model_alias:choice.value, manual_model_override:true}
    : {...config, tool_name:choice.value, manual_tool_override:true};
}

/** Runtime and pre-run pricing must use the same explicit manual choice. */
export function selectedModelAlias(config: Record<string, unknown>, boundAlias?: string): unknown {
  return config.manual_model_override === true ? config.model_alias : boundAlias ?? config.model_alias;
}

export function overrideCostIsMaterial(beforeMinor: number, afterMinor: number, thresholds: NodeOverrideThresholds): boolean {
  const increase = afterMinor - beforeMinor;
  return increase > 0 && increase >= thresholds.costIncreaseMinor && (beforeMinor === 0 || increase >= beforeMinor * thresholds.costIncreaseRatio);
}
