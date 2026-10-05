import type {PoolClient} from "pg";
import type {MarketplaceGovernanceItem, MarketplaceGovernanceResourceType} from "@alterx/contracts";
import {v7 as uuidv7} from "uuid";
import {computeEtag} from "../concurrency/etag";
import {MarketplaceGovernanceHttpError} from "./problem";

export type GovernanceNote = NonNullable<MarketplaceGovernanceItem["review_notes"]>[number];
export interface GovernanceWrite {
  actorRef: string;
  ifMatch: string | undefined;
  audit: (item: MarketplaceGovernanceItem) => Promise<unknown>;
}
export function governanceEtag(id: string, revision: string | number): string {
  return computeEtag(null, `${id}:${revision}`);
}
export function requireGovernanceMatch(id: string, revision: string | number, ifMatch: string | undefined, instance: string): void {
  if (!ifMatch) throw new MarketplaceGovernanceHttpError(428,"PRECONDITION_REQUIRED","Reload the resource and supply its If-Match revision",instance);
  if (ifMatch.trim() !== governanceEtag(id,revision)) throw new MarketplaceGovernanceHttpError(412,"PRECONDITION_FAILED","The resource changed; reload before deciding",instance);
}
export async function appendGovernanceEvent(client: PoolClient, resourceType: MarketplaceGovernanceResourceType,
  item: MarketplaceGovernanceItem, previousStatus: string, revision: string, actorType: "staff" | "seller", actorRef: string,
  action: GovernanceNote["action"], reason: string): Promise<void> {
  await client.query(`INSERT INTO marketplace_governance_events
    (id,tenant_id,resource_type,resource_id,actor_type,actor_ref,action,previous_status,next_status,reason,resource_revision)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [`mge_${uuidv7()}`,item.tenant_id?.replace(/^ten_/, "") ?? null,resourceType,item.id,actorType,actorRef,action,previousStatus,item.status,reason,revision]);
}
export async function governanceNotes(client: Pick<PoolClient,"query">, resourceType: MarketplaceGovernanceResourceType, id: string, limit=100): Promise<GovernanceNote[]> {
  const rows = await client.query<{id: string; actor_type: "staff" | "seller"; actor_ref: string; action: GovernanceNote["action"];
    previous_status: string; next_status: string; reason: string; occurred_at: Date}>(`SELECT id,actor_type,actor_ref,action,previous_status,next_status,reason,occurred_at
    FROM marketplace_governance_events WHERE resource_type=$1 AND resource_id=$2 ORDER BY occurred_at DESC,id DESC LIMIT $3`,[resourceType,id,limit]);
  return rows.rows.map(row=>({...row,occurred_at:row.occurred_at.toISOString()}));
}

export function governanceAuditScope(item:MarketplaceGovernanceItem):readonly string[]{
  const note=item.review_notes?.[0];
  if(!note)throw new Error("Governance audit requires recorded local history");
  return ["marketplace:governance",`history:${note.id}`];
}
