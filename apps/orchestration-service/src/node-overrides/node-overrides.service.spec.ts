import { describe,expect,it,vi } from "vitest";
import { CompiledDagSchema,NodeOverrideThresholdsSchema,type CompiledDag } from "@alterx/contracts";
import { WorstCaseRunCostEstimator } from "../budgets/worst-case-run-cost-estimator";
import { WorkflowNotFoundError,type OrchestrationTenantStore } from "../workflow-read/workflow-read.service";
import { NodeOverridesService } from "./node-overrides.service";
import { preserveOriginalSelections } from "./original-selection";

const tenant="ten_aaaaaaaa-0000-7000-8000-aaaaaaaaaaaa",workspace="ws_cccccccc-0000-7000-8000-cccccccccccc",workflow="wf_dddddddd-0000-7000-8000-dddddddddddd";
function graph():CompiledDag {
  return CompiledDagSchema.parse({schema_version:"v1",entry_node_keys:["work"],nodes:[
    {key:"work",type:"LLMTask",config:{model_alias:"FAST",prompt:"Summarize"},metadata:{ui:{},selection_binding:{
      binding:{record_id:"original",version:1,kind:"model",rationale:"Original ranked fit",score:.88,factors:{reliability:.9,cost:.5}},
      policy:{reliability_weight:.4,latency_weight:.3,cost_weight:.3},required_capabilities:["text"],required_model_alias:"ADVANCED",model_alias:"FAST",
    }}},
    {key:"next",type:"ToolCall",config:{tool_name:"search.web"},metadata:{ui:{}}},
  ],edges:[{key:"e",from:"work",to:"next",kind:"sequential"}],waves:[{key:"first",order:0,node_keys:["work"],depends_on:[]},{key:"last",order:1,node_keys:["next"],depends_on:["first"]}]});
}
function fixture(thresholds:Record<string,number>={},unpriced=false,contract:unknown=null) {
  const original=graph();
  const store:OrchestrationTenantStore={async withTenant(id,operation) {
    expect(id).toBe(tenant.slice(4));
    return operation({async query<T extends Record<string,unknown>>(sql:string,values:readonly unknown[]=[]) {
      const rows=sql.includes("FROM workflow_versions") ? [{compiled_dag:original}] : values[1] === workspace.slice(3) ? [{id:workflow}] : [];
      return {rowCount:rows.length,rows:rows as unknown as T[]};
    }});
  }};
  const modelsFor=vi.fn(async (alias:string)=>[{provider:"fixture",modelId:alias}]);
  const ledger={worstCase:vi.fn(async ({lines}:{lines:readonly {models:readonly {modelId:string}[]}[]})=>({billableMinor:lines.reduce((sum,line)=>sum+(line.models[0]!.modelId === "CEILING" ? 2500 : 2000),0),unpricedLines:unpriced ? 1 : 0})),runsAverage:vi.fn()};
  const estimator=new WorstCaseRunCostEstimator({modelsFor,maxTokensPerCall:async()=>1000},ledger);
  const http={postJson:vi.fn(async()=>({original_binding:null,candidate:{record_id:"candidate",version:1,kind:"model",source_node_key:"work",rationale:"actual weights",score:.7,factors:{cost:.3},output_contract:contract},warnings:[]}))};
  return {original,http,ledger,modelsFor,service:new NodeOverridesService(store,estimator,http,"http://intelligence",NodeOverrideThresholdsSchema.parse(thresholds))};
}

describe("node override comparison",()=>{
  it("uses immutable original evidence and actual D4 chosen alias prices",async()=>{
    const {service,original,http,modelsFor}=fixture();
    const edited=structuredClone(original);
    edited.nodes[0]!.metadata.selection_binding!.binding.rationale="client replacement";
    edited.nodes[0]!.metadata.selection_binding!.policy!.cost_weight=1;
    const result=await service.compare(tenant,workspace,workflow,{nodeKey:"work",choice:{kind:"model",value:"CEILING"},dag:edited});
    expect(result.original.selection).toEqual(original.nodes[0]!.metadata.selection_binding);
    expect(http.postJson).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({policy:original.nodes[0]!.metadata.selection_binding!.policy,original_binding:expect.objectContaining({rationale:"Original ranked fit"})}));
    expect(modelsFor.mock.calls.map(([alias])=>alias)).toEqual(["CEILING","FAST"]);
    expect(result.cost).toEqual({currency:"INR",before_minor:2000,after_minor:2500});
    expect(result.warnings.some(item=>item.code === "cost")).toBe(true);
    expect(result.validation.valid).toBe(true);
  });
  it("requires both configured cost thresholds",async()=>{
    for (const thresholds of [{costIncreaseRatio:.26},{costIncreaseMinor:501}]) {
      const {service,original}=fixture(thresholds);
      const result=await service.compare(tenant,workspace,workflow,{nodeKey:"work",choice:{kind:"model",value:"CEILING"},dag:original});
      expect(result.warnings.some(item=>item.code === "cost")).toBe(false);
    }
  });
  it("does not present an unpriced D4 bound as a complete cost",async()=>{
    const {service,original}=fixture({},true);
    const result=await service.compare(tenant,workspace,workflow,{nodeKey:"work",choice:{kind:"model",value:"CEILING"},dag:original});
    expect(result.cost).toEqual({currency:"INR",before_minor:null,after_minor:null});
    expect(result.warnings.some(item=>item.code === "cost_unavailable")).toBe(true);
  });
  it("reports a downstream contract mismatch and graph errors without refusing the choice",async()=>{
    const {service,original}=fixture({},false,{type:"object",properties:{summary:{type:"number"}},required:["summary"]});
    original.nodes[1]!.metadata.data_contract={inputs:{work:{type:"object",properties:{summary:{type:"string"}},required:["summary"]}}};
    const result=await service.compare(tenant,workspace,workflow,{nodeKey:"work",choice:{kind:"model",value:"CEILING"},dag:original});
    expect(result.choice.value).toBe("CEILING");
    expect(result.validation.valid).toBe(false);
    expect(result.warnings.some(item=>item.code === "downstream_contract")).toBe(true);
  });
  it("does not compare a workflow outside the caller workspace",async()=>{
    const {service,original,http}=fixture();
    await expect(service.compare(tenant,"ws_eeeeeeee-0000-7000-8000-eeeeeeeeeeee",workflow,{nodeKey:"work",choice:{kind:"model",value:"CEILING"},dag:original})).rejects.toBeInstanceOf(WorkflowNotFoundError);
    expect(http.postJson).not.toHaveBeenCalled();
  });
  it("reports unavailable provider advice while retaining choice and structural validation",async()=>{
    const {service,original,http}=fixture();http.postJson.mockRejectedValue(new Error("unavailable"));
    const result=await service.compare(tenant,workspace,workflow,{nodeKey:"work",choice:{kind:"model",value:"CEILING"},dag:original});
    expect(result.candidate).toBeNull();expect(result.choice.value).toBe("CEILING");expect(result.validation.valid).toBe(true);
    expect(result.warnings.some(item=>item.code === "facts_unavailable")).toBe(true);
  });
});

it("retains the first original choice through successive canvas saves and removes unrecorded evidence",()=>{
  const original=graph();const edited=structuredClone(original);
  edited.nodes[0]!.config={...edited.nodes[0]!.config,manual_model_override:true,model_alias:"CEILING"};
  edited.nodes[0]!.metadata.selection_binding!.binding.rationale="Submitted replacement";
  const saved=preserveOriginalSelections(edited,original);
  expect(saved.nodes[0]!.metadata.selection_binding).toEqual(original.nodes[0]!.metadata.selection_binding);
  const again=preserveOriginalSelections({...saved,nodes:saved.nodes.map(node=>({...node,metadata:{ui:{}}}))},saved);
  expect(again.nodes[0]!.metadata.original_choice).toEqual({kind:"model",value:"FAST"});
  expect(again.nodes[0]!.metadata.selection_binding).toEqual(original.nodes[0]!.metadata.selection_binding);
  expect(preserveOriginalSelections(edited,undefined).nodes[0]!.metadata).not.toHaveProperty("selection_binding");
});
