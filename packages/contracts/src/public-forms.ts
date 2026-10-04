import { z } from "./zod";
import { TenantIdSchema, TriggerIdSchema } from "./ids";

const field = {
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).refine(name => !["constructor", "prototype", "__proto__"].includes(name), "Reserved field name"),
  label: z.string().trim().min(1).max(120),
  required: z.boolean().default(false),
};
const options = z.array(z.string().trim().min(1).max(120)).min(1).max(30)
  .refine(values => new Set(values).size === values.length, "Options must be distinct");

export const HostedFormFieldSchema = z.discriminatedUnion("type", [
  z.object({ ...field, type: z.enum(["text", "textarea"]), maxLength: z.number().int().min(1).max(10000).default(2000) }).strict(),
  z.object({ ...field, type: z.literal("email") }).strict(),
  z.object({ ...field, type: z.literal("number"), min: z.number().finite().optional(), max: z.number().finite().optional() }).strict(),
  z.object({ ...field, type: z.literal("select"), options }).strict(),
]);
export const HostedFormDefinitionSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).optional(),
  fields: z.array(HostedFormFieldSchema).min(1).max(20),
}).strict().superRefine((value, ctx) => {
  const names = new Set<string>();
  for (const [index, item] of value.fields.entries()) {
    if (names.has(item.name)) ctx.addIssue({ code: "custom", message: "Field names must be distinct", path: ["fields", index, "name"] });
    names.add(item.name);
    if (item.type === "number" && item.min !== undefined && item.max !== undefined && item.min > item.max) ctx.addIssue({ code: "custom", message: "Minimum cannot exceed maximum", path: ["fields", index, "min"] });
  }
});
export type HostedFormField = z.infer<typeof HostedFormFieldSchema>;
export type HostedFormDefinition = z.infer<typeof HostedFormDefinitionSchema>;

export const PublicFormTokenClaimsSchema = z.object({
  tenantId: TenantIdSchema, triggerId: TriggerIdSchema,
  // Trigger Registry persists trv_ ids; bind capabilities to its actual identifier.
  triggerVersionId: z.string().regex(/^trv_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
}).strict();
export type PublicFormTokenClaims = z.infer<typeof PublicFormTokenClaimsSchema>;

export const HostedFormSetupSchema = z.object({
  definition: HostedFormDefinitionSchema, publicUrl: z.string().url(),
  triggerVersionId: PublicFormTokenClaimsSchema.shape.triggerVersionId,
  version: z.number().int().positive(), status: z.enum(["draft", "enabled", "disabled", "archived"]),
  etag: z.string().min(1),
}).strict();
export type HostedFormSetup = z.infer<typeof HostedFormSetupSchema>;

/** Keep values intact; only definitions are normalized during authoring. */
export function hostedFormValuesSchema(definition: HostedFormDefinition) {
  const shape: Record<string, z.ZodType<string | number | undefined>> = {};
  for (const item of HostedFormDefinitionSchema.parse(definition).fields) {
    let value: z.ZodType<string | number>;
    if (item.type === "number") {
      let number = z.number().finite();
      if (item.min !== undefined) number = number.min(item.min);
      if (item.max !== undefined) number = number.max(item.max);
      value = number;
    } else if (item.type === "email") value = z.string().max(254).email();
    else if (item.type === "select") value = z.string().refine(input => item.options.includes(input), "Choose a listed option");
    else {
      const text = z.string().max(item.maxLength);
      value = item.required ? text.refine(input => input.trim().length > 0, "Field is required") : text;
    }
    shape[item.name] = item.required ? value : value.optional();
  }
  return z.object(shape).strict();
}
