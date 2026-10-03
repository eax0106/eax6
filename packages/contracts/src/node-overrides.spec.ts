import { describe, expect, it } from "vitest";
import { CompiledDagSchema } from "./workflow-dag";
import { DataContractSchema, NodeOverrideChoiceSchema, NodeOverrideThresholdsSchema, dataContractFits, overrideCostIsMaterial } from "./node-overrides";

const graph = () => ({
  schema_version:"v1",entry_node_keys:["work"],
  nodes:[
    {key:"work",type:"LLMTask",config:{model_alias:"FAST",manual_model_override:true},metadata:{ui:{}}},
    {key:"notify",type:"ToolCall",config:{tool_name:"email.send"},metadata:{ui:{}}},
  ],
  edges:[{key:"work-notify",from:"work",to:"notify",kind:"sequential"}],
  waves:[{key:"first",order:0,node_keys:["work"],depends_on:[]},{key:"second",order:1,node_keys:["notify"],depends_on:["first"]}],
});

describe("manual graph preflight",()=>{
  it("rejects a non-loop cycle after a manual edit",()=>{
    const dag=graph();dag.edges.push({key:"back",from:"notify",to:"work",kind:"sequential"});
    expect(CompiledDagSchema.safeParse(dag).success).toBe(false);
  });
  it("rejects an orphan outside the declared entry paths after a manual edit",()=>{
    const dag=graph();dag.edges=[];
    expect(CompiledDagSchema.safeParse(dag).success).toBe(false);
  });
  it("rejects a declared downstream type mismatch after a manual edit",()=>{
    const dag=graph();
    Object.assign(dag.nodes[0]!.metadata,{data_contract:{output:{type:"object",properties:{summary:{type:"number"}},required:["summary"]}}});
    Object.assign(dag.nodes[1]!.metadata,{data_contract:{inputs:{work:{type:"object",properties:{summary:{type:"string"}},required:["summary"]}}}});
    expect(CompiledDagSchema.safeParse(dag).success).toBe(false);
  });
  it("accepts a valid manual choice and keeps graph criteria/evidence separate from config",()=>{
    const dag=graph();expect(CompiledDagSchema.safeParse(dag).success).toBe(true);
    Object.assign(dag.nodes[0]!.config,{manual_model_override:"true"});
    expect(CompiledDagSchema.safeParse(dag).success).toBe(false);
  });
});

it("requires both configured cost thresholds and a real increase",()=>{
  const thresholds=NodeOverrideThresholdsSchema.parse({});
  expect(overrideCostIsMaterial(2000,2500,thresholds)).toBe(true);
  expect(overrideCostIsMaterial(2000,2499,thresholds)).toBe(false);
  expect(overrideCostIsMaterial(10000,12499,thresholds)).toBe(false);
  expect(overrideCostIsMaterial(100,125,thresholds)).toBe(false);
  expect(overrideCostIsMaterial(0,500,thresholds)).toBe(true);
  expect(overrideCostIsMaterial(1000,1000,NodeOverrideThresholdsSchema.parse({costIncreaseRatio:0,costIncreaseMinor:0}))).toBe(false);
  expect(overrideCostIsMaterial(1000,1100,NodeOverrideThresholdsSchema.parse({costIncreaseRatio:.1,costIncreaseMinor:100}))).toBe(true);
});

it("validates canonical choices and declared field/item types without guessing missing guarantees",()=>{
  expect(NodeOverrideChoiceSchema.safeParse({kind:"model",value:"ULTRA"}).success).toBe(false);
  expect(NodeOverrideChoiceSchema.safeParse({kind:"tool",value:"made.up"}).success).toBe(false);
  expect(DataContractSchema.safeParse({type:"object",required:["missing"]}).success).toBe(false);
  expect(dataContractFits({type:"integer"},{type:"number"})).toBe(true);
  expect(dataContractFits({type:"number"},{type:"integer"})).toBe(false);
  expect(dataContractFits({type:"array"},{type:"array",items:{type:"string"}})).toBe(false);
  expect(dataContractFits({type:"object",properties:{value:{type:"string"}}},{type:"object",properties:{value:{type:"string"}},required:["value"]})).toBe(false);
});
