import {z} from "./zod";
import {TenantIdSchema,prefixedUuidV7} from "./ids";
export const BillingOperationsTenantSchema=z.string().uuid().refine(value=>TenantIdSchema.safeParse(`ten_${value}`).success,"Expected a bare tenant UUIDv7");
const reason=z.string().trim().min(1).max(1000);
export const StaffBillingActionRequestSchema=z.discriminatedUnion("action",[
 z.object({action:z.literal("retry"),reason}).strict(),
 z.object({action:z.literal("resolve"),reason}).strict(),
 z.object({action:z.literal("grant_credits"),reason,runs:z.number().int().positive().max(1_000_000)}).strict(),
]);
export const StaffRunCreditRequestSchema=z.object({runs:z.number().int().positive().max(1_000_000),reason}).strict();
export const StaffBillingReasonRequestSchema=z.object({reason}).strict();
export const BillingOperationsEtagSchema=z.string().regex(/^"billing-[0-9a-f-]{36}-[1-9][0-9]*"$/i);
export const StaffBillingIssueSchema=z.object({tenant_id:BillingOperationsTenantSchema,tenant_name:z.string(),state:z.enum(["grace","limited","suspended"]),current_plan:z.string().nullable(),first_failed_at:z.string().datetime().nullable(),updated_at:z.string().datetime(),etag:BillingOperationsEtagSchema}).strict().refine(value=>value.etag.startsWith(`"billing-${value.tenant_id}-`),"Revision must belong to the tenant");
export const StaffBillingIssuesSchema=z.array(StaffBillingIssueSchema).max(500).refine(rows=>new Set(rows.map(row=>row.tenant_id)).size===rows.length,"Duplicate billing subject");
export const RazorpayRecoveryUrlSchema=z.string().url().max(2048).refine(value=>{try{const u=new URL(value);return u.protocol==="https:"&&u.hostname==="rzp.io"&&!u.port&&!u.username&&!u.password&&!u.hash&&u.pathname!=="/";}catch{return false;}},"Expected an actual Razorpay-hosted recovery URL");
export const StaffBillingOperationSchema=z.object({id:prefixedUuidV7("bop"),tenant_id:BillingOperationsTenantSchema,action:z.enum(["retry","resolve","grant_credits"]),actor_ref:z.string().regex(/^stf_[a-z0-9._:-]{1,127}$/i),reason,created_at:z.string().datetime(),etag:BillingOperationsEtagSchema,runs:z.number().int().positive().nullable(),credits:z.number().int().positive().max(1_000_000_000).nullable(),delivery:z.enum(["pending","delivered"]).nullable(),recovery_url:RazorpayRecoveryUrlSchema.nullable(),subscription_ref:z.string().nullable(),invoice_ref:z.string().nullable()}).strict().superRefine((value,ctx)=>{
 if(!value.etag.startsWith(`"billing-${value.tenant_id}-`))ctx.addIssue({code:z.ZodIssueCode.custom,message:"Revision must belong to the tenant"});
 if(value.action==="grant_credits"?value.runs===null||value.credits===null||value.delivery===null||value.recovery_url!==null||value.invoice_ref!==null:value.runs!==null||value.credits!==null||value.delivery!==null)ctx.addIssue({code:z.ZodIssueCode.custom,message:"Action evidence is inconsistent"});
 if(value.action==="retry"&&(value.recovery_url===null||value.subscription_ref===null||value.invoice_ref!==null))ctx.addIssue({code:z.ZodIssueCode.custom,message:"Recovery needs the actual provider URL"});
 if(value.action==="resolve"&&(value.invoice_ref===null||value.subscription_ref===null||value.recovery_url!==null))ctx.addIssue({code:z.ZodIssueCode.custom,message:"Resolution needs provider payment evidence"});
});
export const StaffBillingHistorySchema=z.array(StaffBillingOperationSchema).max(200);
export type StaffBillingActionRequest=z.infer<typeof StaffBillingActionRequestSchema>;
export type StaffBillingOperation=z.infer<typeof StaffBillingOperationSchema>;
export type StaffBillingIssue=z.infer<typeof StaffBillingIssueSchema>;
