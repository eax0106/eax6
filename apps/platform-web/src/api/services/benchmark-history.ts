import {apiGet,isLiveApi} from "../http"
export interface EvaluationHistoryRun {
 id:string;goldenSetName:string;goldenSetDomain:string;goldenSetVersion:number;subject:string;trigger:string;
 status:"pending"|"running"|"completed"|"failed"|"cancelled";passRate:number|null;startedAt:string|null;completedAt:string|null;createdAt:string;
}
export interface EvaluationHistoryPage {data:EvaluationHistoryRun[];nextCursor:string|null}
export const benchmarkHistoryService={
 async list(input:{limit?:number;cursor?:string|undefined;goldenSet?:string|undefined}={}):Promise<EvaluationHistoryPage>{
  if(!isLiveApi)return {data:[],nextCursor:null}
  const query=new URLSearchParams({limit:String(input.limit??25),...(input.cursor?{cursor:input.cursor}:{}),...(input.goldenSet?{golden_set:input.goldenSet}:{})})
  return apiGet<EvaluationHistoryPage>(`/api/v1/admin/benchmarks/runs?${query}`)
 }
}
