import { describe, expect, it } from "vitest"

import { compileDag, dagToCanvas, WorkflowGraphCycleError } from "./compile-dag"

const nodes = [
  { id: "trigger", type: "YAMLImport", position: { x: 0, y: 0 }, data: { label: "Trigger" } },
  { id: "review", type: "HumanApproval", position: { x: 0, y: 0 }, data: { label: "Review" } },
  { id: "publish", type: "PubSub", position: { x: 0, y: 0 }, data: { label: "Publish" } },
]

describe("compileDag", () => {
  it("keeps original binding evidence, declared contracts and manual aliases outside config", () => {
    const source = compileDag([{ id:"work",type:"LLMTask",position:{x:0,y:0},data:{label:"work",model_alias:"CEILING",manual_model_override:true} }], [])
    source.nodes[0]!.metadata.original_choice = {kind:"model",value:"STANDARD"}
    source.nodes[0]!.metadata.selection_binding = {binding:{record_id:"model-original",version:2,kind:"model",rationale:"Required reasoning fit",score:.85,factors:{reliability:.9}},required_capabilities:["text"],model_alias:"STANDARD"}
    source.nodes[0]!.metadata.data_contract = {output:{type:"object",properties:{summary:{type:"string"}},required:["summary"]}}
    const canvas = dagToCanvas(source), result = compileDag(canvas.nodes,canvas.edges)
    expect(result.nodes[0]!.metadata).toEqual(source.nodes[0]!.metadata)
    expect(result.nodes[0]!.config).toEqual({model_alias:"CEILING",manual_model_override:true})
  })
  it("places a fan-in after both unequal length branches", () => {
    const ns = ["start","short","long","later","join"].map(id => ({id,type:"LLMTask",data:{model_alias:"FAST"},position:{x:0,y:0}}))
    const es = [["start","short"],["start","long"],["long","later"],["short","join"],["later","join"]].map(([source,target],i)=>({id:`e${i}`,source,target}))
    const dag = compileDag(ns,es)
    expect(dag.waves.map(wave=>wave.node_keys)).toEqual([["start"],["short","long"],["later"],["join"]])
  })
  it("retains the actual approval action and expiry through a canvas round trip", () => {
    const dag=compileDag([{id:"approve",type:"HumanApproval",data:{label:"Approve",requested_action:{kind:"run_node",node_key:"send"},expiry_seconds:120},position:{x:0,y:0}}],[])
    const canvas=dagToCanvas(dag)
    expect(compileDag(canvas.nodes,canvas.edges).nodes[0]!.config).toEqual({requested_action:{kind:"run_node",node_key:"send"},expiry_seconds:120})
  })
  it("preserves bounded loop and merge edges without treating a loop as a forward cycle", () => {
    const source = compileDag(nodes,[{id:"a",source:"trigger",target:"review"},{id:"b",source:"review",target:"publish"}])
    source.edges[1]!.kind = "merge"
    source.edges.push({key:"again",from:"publish",to:"review",kind:"loop",loop:{max_iterations:2,exit_condition:{expression:"true",language:"cel"}}})
    const canvas = dagToCanvas(source), result = compileDag(canvas.nodes,canvas.edges)
    expect(result.edges).toEqual(source.edges)
    expect(result.entry_node_keys).toEqual(["trigger"])
  })
  it("keeps workflow and node criteria outside config through a canvas edit", () => {
    const source = compileDag(nodes, [])
    source.success_criteria = ["Review the invoice."]
    source.nodes[0]!.success_criteria = ["Read the invoice."]
    const canvas = dagToCanvas(source)
    canvas.nodes[0].data.label = "Edited label"
    const result = compileDag(canvas.nodes, canvas.edges, source.success_criteria)
    expect(result.success_criteria).toEqual(source.success_criteria)
    expect(result.nodes[0]!.success_criteria).toEqual(source.nodes[0]!.success_criteria)
    expect(result.nodes[0]!.config).not.toHaveProperty("successCriteria")
  })
  it("compiles a valid DAG into ordered waves", () => {
    const dag = compileDag(nodes, [
      { id: "trigger-review", source: "trigger", target: "review" },
      { id: "review-publish", source: "review", target: "publish" },
    ])

    expect(dag.entry_node_keys).toEqual(["trigger"])
    expect(dag.waves.map((wave) => wave.node_keys)).toEqual([
      ["trigger"],
      ["review"],
      ["publish"],
    ])
  })

  it("rejects a cycle and names only the participating nodes", () => {
    expect(() => compileDag(nodes, [
      { id: "trigger-review", source: "trigger", target: "review" },
      { id: "review-publish", source: "review", target: "publish" },
      { id: "publish-review", source: "publish", target: "review" },
    ])).toThrow("Publish, Review")

    try {
      compileDag(nodes, [
        { id: "trigger-review", source: "trigger", target: "review" },
        { id: "review-publish", source: "review", target: "publish" },
        { id: "publish-review", source: "publish", target: "review" },
      ])
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowGraphCycleError)
      expect((error as WorkflowGraphCycleError).nodeIds).toEqual(["publish", "review"])
    }
  })
})
