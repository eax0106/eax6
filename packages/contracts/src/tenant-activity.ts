import { z } from "./zod";
import { IsoTimestampSchema, RunIdSchema, WorkflowIdSchema } from "./ids";
import { PlatformTenantIdSchema } from "./operations";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const TenantActivityCountFromStorageSchema = z.string().regex(/^\d+$/).transform(value => BigInt(value))
  .refine(value => value <= BigInt(Number.MAX_SAFE_INTEGER), "Recorded count exceeds the safe integer range")
  .transform(value => Number(value));
const thirtyDays = (value: { start_at: string; end_at: string }) => Date.parse(value.end_at) - Date.parse(value.start_at) === 30 * 24 * 60 * 60 * 1000;
export const TenantActivityWindowSchema = z.object({
  tenant_id: PlatformTenantIdSchema,
  start_at: IsoTimestampSchema,
  end_at: IsoTimestampSchema,
}).strict().refine(thirtyDays,
  "Activity requires an exact thirty-day window");

export const TenantEngineActivitySchema = z.object({
  tenant_id: PlatformTenantIdSchema,
  start_at: IsoTimestampSchema,
  end_at: IsoTimestampSchema,
  workflow_count: count,
  run_count: count,
  workflows: z.array(z.object({ id: WorkflowIdSchema, workspace_id: z.uuid(), name: z.string(), status: z.string(), updated_at: IsoTimestampSchema }).strict()).max(50),
  runs: z.array(z.object({ id: RunIdSchema, workspace_id: z.uuid(), workflow_id: WorkflowIdSchema.nullable(), status: z.string(), created_at: IsoTimestampSchema }).strict()).max(50),
}).strict().refine(thirtyDays, "Activity requires an exact thirty-day window")
  .refine(value => value.workflow_count >= value.workflows.length && value.run_count >= value.runs.length, "Activity totals must include the returned records")
  .refine(value => value.runs.every(run => Date.parse(run.created_at) >= Date.parse(value.start_at) && Date.parse(run.created_at) < Date.parse(value.end_at)), "Recent runs must fall within the activity window");

export const TenantBilledSpendSchema = z.object({
  tenant_id: PlatformTenantIdSchema,
  start_at: IsoTimestampSchema,
  end_at: IsoTimestampSchema,
  currencies: z.array(z.object({ currency: z.enum(["INR", "USD"]), billed_minor: z.string().regex(/^\d+$/), event_count: count }).strict()).max(2),
}).strict().refine(thirtyDays, "Spend requires an exact thirty-day window")
  .refine(value => new Set(value.currencies.map(total => total.currency)).size === value.currencies.length && value.currencies.every(total => total.event_count > 0), "Currency totals must be unique and based on recorded events");

export const TenantMembersSchema = z.object({
  count,
  members: z.array(z.object({ id: z.uuid(), email: z.string(), name: z.string().nullable(), role: z.string() }).strict()).max(50),
}).strict().refine(value => value.count >= value.members.length, "Member total must include the returned records");

export const TenantDetailActivitySchema = TenantEngineActivitySchema.safeExtend({
  members: TenantMembersSchema,
  spend: TenantBilledSpendSchema,
}).strict().refine(value => value.spend.tenant_id === value.tenant_id && value.spend.start_at === value.start_at && value.spend.end_at === value.end_at,
  "Spend and activity must describe the same tenant and period");

export type TenantActivityWindow = z.infer<typeof TenantActivityWindowSchema>;
export type TenantEngineActivity = z.infer<typeof TenantEngineActivitySchema>;
export type TenantBilledSpend = z.infer<typeof TenantBilledSpendSchema>;
export type TenantMembers = z.infer<typeof TenantMembersSchema>;
export type TenantDetailActivity = z.infer<typeof TenantDetailActivitySchema>;
