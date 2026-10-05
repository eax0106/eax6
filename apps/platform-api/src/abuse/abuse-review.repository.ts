import {v7 as uuidv7} from "uuid";
import type {Pool,PoolClient} from "pg";
import type {AbuseSignal,SecurityReviewStaff} from "@alterx/contracts";
import {AbuseSignalsHttpError} from "./problem";

export interface AbuseSignalRow {
  id:string;tenant_id:string;signal_type:AbuseSignal["signal_type"];source:string;score:string|number;evidence_ref:string;
  observed_at:Date;status:AbuseSignal["status"];revision:string;
  assigned_to:string|null;assigned_by:string|null;assigned_at:Date|null;assignment_reason:string|null;
  staff_email:string|null;assignee_active:boolean|null;
}
export interface AbuseReviewWrite {
  readonly ifMatch:string|undefined;
  readonly audit:(signal:AbuseSignal,historyId:string)=>Promise<unknown>;
}
const columns=`s.id,s.tenant_id,s.signal_type,s.source,s.score,s.evidence_ref,s.observed_at,s.status,s.revision,
 s.assigned_to,s.assigned_by,s.assigned_at,s.assignment_reason,a.email AS staff_email,
 (a.deactivated_at IS NULL AND a.roles && ARRAY['staff_admin','staff_security']::text[]) AS assignee_active`;
export const abuseSignalProjection=`SELECT ${columns} FROM abuse_signals s LEFT JOIN staff_users a ON a.id=s.assigned_to`;
export const abuseSignalEtag=(id:string,revision:string)=>`"${id}:rev-${revision}"`;
export function mapAbuseSignal(row:AbuseSignalRow):AbuseSignal {
  return {id:row.id,tenant_id:row.tenant_id,signal_type:row.signal_type,source:row.source,score:Number(row.score),evidence_ref:row.evidence_ref,observed_at:row.observed_at.toISOString(),status:row.status,
    etag:abuseSignalEtag(row.id,row.revision),assignment:row.assigned_to?{staff_user_id:row.assigned_to,staff_email:row.staff_email!,active:row.assignee_active===true,assigned_by:row.assigned_by!,assigned_at:row.assigned_at!.toISOString(),reason:row.assignment_reason!}:null};
}
/** Current staff-only signal mutations share a locked revision and audit transaction. */
export class AbuseReviewRepository {
 constructor(private readonly pool:Pool){}
 async eligibleStaff():Promise<SecurityReviewStaff[]> {
  const result=await this.pool.query<SecurityReviewStaff>("SELECT id,email,roles FROM staff_users WHERE deactivated_at IS NULL AND roles && ARRAY['staff_admin','staff_security']::text[] ORDER BY email,id");
  return result.rows;
 }
 assign(id:string,target:string,reason:string,actor:string,write:AbuseReviewWrite):Promise<AbuseSignal|undefined> {
  return this.mutate(id,"assign",reason,actor,write,async(tx)=>{
   const staff=await tx.query("SELECT id FROM staff_users WHERE id=$1 AND deactivated_at IS NULL AND roles && ARRAY['staff_admin','staff_security']::text[] FOR SHARE",[target]);
   if(!staff.rows.length)throw problem(409,"ABUSE_ASSIGNEE_UNAVAILABLE","Choose an active eligible staff member",id);
   await tx.query("UPDATE abuse_signals SET assigned_to=$2,assigned_by=$3,assigned_at=clock_timestamp(),assignment_reason=$4,updated_at=clock_timestamp() WHERE id=$1",[id,target,actor,reason]);
  });
 }
 review(id:string,decision:"confirm"|"dismiss",reason:string,actor:string,write:AbuseReviewWrite):Promise<AbuseSignal|undefined> {
  return this.mutate(id,decision,reason,actor,write,async tx=>{
   await tx.query("UPDATE abuse_signals SET status=$2,reviewed_by=$3,reviewed_at=clock_timestamp(),review_reason=$4,updated_at=clock_timestamp() WHERE id=$1",[id,decision==="confirm"?"confirmed":"dismissed",actor,reason]);
  });
 }
 private async mutate(id:string,action:"assign"|"confirm"|"dismiss",reason:string,actor:string,write:AbuseReviewWrite,change:(tx:PoolClient)=>Promise<void>):Promise<AbuseSignal|undefined> {
  if(!write.ifMatch?.trim())throw problem(428,"PRECONDITION_REQUIRED","If-Match is required",id);
  const tx=await this.pool.connect();
  try{
   await tx.query("BEGIN");
   const found=await tx.query<{tenant_id:string}>("SELECT tenant_id::text FROM abuse_signals WHERE id=$1",[id]);
   if(!found.rows.length){await tx.query("ROLLBACK");return undefined;}
   const tenant=found.rows[0]!.tenant_id;await tx.query("SELECT set_config('app.current_tenant_id',$1,true)",[tenant]);
   const subject=await tx.query("SELECT id FROM tenants WHERE id=$1 AND deleted_at IS NULL FOR SHARE",[tenant]);
   if(!subject.rows.length){await tx.query("ROLLBACK");return undefined;}
   const locked=await tx.query<{status:string;revision:string}>("SELECT status,revision::text FROM abuse_signals WHERE id=$1 AND tenant_id=$2 FOR UPDATE",[id,tenant]);
   if(!locked.rows.length){await tx.query("ROLLBACK");return undefined;}
   const before=locked.rows[0]!;
   if(write.ifMatch.trim()!==abuseSignalEtag(id,before.revision))throw problem(412,"PRECONDITION_FAILED","Reload the current security review",id);
   if(before.status!=="open")throw problem(409,"ABUSE_SIGNAL_NOT_OPEN","Security review is already closed",id);
   await change(tx);
   const updated=await tx.query<AbuseSignalRow>(abuseSignalProjection+" WHERE s.id=$1",[id]);
   const row=updated.rows[0]!,signal=mapAbuseSignal(row),historyId=`asa_${uuidv7()}`;
   await tx.query("INSERT INTO abuse_signal_actions(id,tenant_id,signal_id,action,actor_ref,assignee_ref,reason,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[historyId,tenant,id,action,actor,row.assigned_to,reason,row.revision]);
   await write.audit(signal,historyId);
   await tx.query("COMMIT");return signal;
  }catch(error){await tx.query("ROLLBACK");throw error;}finally{tx.release();}
 }
}
function problem(status:number,code:string,detail:string,id:string){return new AbuseSignalsHttpError(status,code,detail,`/api/v1/admin/abuse/signals/${id}`);}
