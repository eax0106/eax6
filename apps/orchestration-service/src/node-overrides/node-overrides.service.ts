import { z } from "zod";
import {
  CompiledDagSchema, DataContractSchema, NodeOverrideComparisonSchema, NodeOverrideRequestSchema,
  TenantIdSchema, WorkspaceIdSchema, WorkflowIdSchema, applyNodeOverride, hasExternalSideEffect,
  overrideCostIsMaterial, ModelAliasSchema, NodeOverrideSafeguardsSchema, withNodeOverrideSafeguards,
  type CompiledDag, type NodeOverrideComparison, type NodeOverrideThresholds,
} from "@alterx/contracts";
import type { SelectionBindingHttpClient } from "@alterx/adapters";
import type { WorstCaseRunCostEstimator } from "../budgets/worst-case-run-cost-estimator";
import { WorkflowNotFoundError, WorkflowValidationError, type OrchestrationTenantStore } from "../workflow-read/workflow-read.service";
import { originalChoice, preserveOriginalSelections } from "./original-selection";

const CritiqueResponseSchema=z.object({
  original_binding:z.unknown().nullable(),
  candidate:NodeOverrideComparisonSchema.shape.candidate,
  warnings:NodeOverrideComparisonSchema.shape.warnings,
}).strict();

export class NodeOverridesService {
  constructor(
    private readonly store: OrchestrationTenantStore,
    private readonly estimator: WorstCaseRunCostEstimator,
    private readonly http: SelectionBindingHttpClient,
    private readonly intelligenceBaseUrl: string,
    private readonly thresholds: NodeOverrideThresholds,
  ) {}

  async compare(tenantId:string,workspaceId:string,workflowId:string,raw:unknown):Promise<NodeOverrideComparison> {
    if (!TenantIdSchema.safeParse(tenantId).success || !WorkspaceIdSchema.safeParse(workspaceId).success || !WorkflowIdSchema.safeParse(workflowId).success) throw new WorkflowValidationError("Invalid workflow context");
    const input=NodeOverrideRequestSchema.extend({overrideSafeguards:NodeOverrideSafeguardsSchema.optional()}).safeParse(raw);
    if (!input.success) throw new WorkflowValidationError("Invalid node override request");
    // The comparison accepts a structurally typed graph, then returns full preflight errors.
    const parsed=z.object(CompiledDagSchema.shape).strict().safeParse(input.data.dag);
    if (!parsed.success) throw new WorkflowValidationError(`Invalid graph: ${parsed.error.issues.map(issue=>issue.message).join("; ")}`);
    const stored=await this.store.withTenant(tenantId.slice(4),async tx=>{
      const workflow=await tx.query("SELECT id FROM workflows WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3",[tenantId.slice(4),workspaceId.slice(3),workflowId]);
      if (!workflow.rowCount) throw new WorkflowNotFoundError(workflowId);
      const result=await tx.query<{compiled_dag:unknown}>("SELECT compiled_dag FROM workflow_versions WHERE tenant_id=$1 AND workflow_id=$2 ORDER BY version DESC LIMIT 1",[tenantId.slice(4),workflowId]);
      return result.rows[0] ? CompiledDagSchema.parse(result.rows[0].compiled_dag) : undefined;
    });
    const dag=preserveOriginalSelections(parsed.data,stored);
    const node=dag.nodes.find(item=>item.key===input.data.nodeKey);
    const choice=input.data.choice;
    if (!node || (choice.kind === "model" ? node.type !== "LLMTask" : node.type !== "ToolCall")) throw new WorkflowValidationError("Choice does not match the selected node type");
    const original=stored?.nodes.find(item=>item.key===node.key && item.type===node.type);
    const selection=original?.metadata.selection_binding ?? null;
    const previousChoice=originalChoice(original) ?? null;
    const warnings:NodeOverrideComparison["warnings"]=[];
    const warn=(code:string,message:string)=>warnings.push({code,message});
    let candidate:NodeOverrideComparison["candidate"]=null;
    try {
      const advice=CritiqueResponseSchema.parse(await this.http.postJson(`${this.intelligenceBaseUrl}/selection-binding/critique-override`,{
        tenant_id:tenantId,workspace_id:workspaceId,node_key:node.key,choice,
        original_binding:selection ? {...selection.binding,source_node_key:node.key} : null,
        required_capabilities:selection?.required_capabilities ?? [],required_model_alias:selection?.required_model_alias ?? null,
        policy:selection?.policy ?? null,latency_multiplier:this.thresholds.latencyMultiplier,
      }));
      if (advice.candidate && (advice.candidate.source_node_key !== node.key || advice.candidate.kind !== choice.kind)) throw new Error("Provider comparison does not match the selected node");
      candidate=advice.candidate; warnings.push(...advice.warnings);
    } catch {
      warn("facts_unavailable","Provider comparison is unavailable. The manual choice remains editable.");
    }
    if (!selection) warn("facts_unavailable","Original selection scores and required capabilities were not recorded for this node.");
    if (choice.kind === "tool" && hasExternalSideEffect(choice.value) && (previousChoice?.kind !== "tool" || !hasExternalSideEffect(previousChoice.value)) && !warnings.some(item=>item.code === "outside_action")) warn("outside_action","Chosen tool adds an outside action; normal tool permissions and approval steps still apply.");
    const output=DataContractSchema.safeParse(candidate?.output_contract);
    // A changed provider cannot inherit an unverified output guarantee from the old one.
    const dataContract={...(node.metadata.data_contract?.inputs ? {inputs:node.metadata.data_contract.inputs} : {}),...(output.success ? {output:output.data} : {})};
    if (!output.success) warn("facts_unavailable","Chosen provider has no valid declared output contract; downstream compatibility is unknown.");
    const approvalRequired=input.data.overrideSafeguards?.approval_required ?? true;
    const proposed=withNodeOverrideSafeguards({...dag,nodes:dag.nodes.map(item=>item.key === node.key ? {...item,config:applyNodeOverride(item.config,choice),metadata:{...item.metadata,data_contract:dataContract}} : item)},approvalRequired);
    const validation=CompiledDagSchema.safeParse(proposed);
    const errors=validation.success ? [] : validation.error.issues.map(issue=>`${issue.path.join(".")}: ${issue.message}`);
    if (errors.some(error=>error.includes("Output contract does not fit"))) warn("downstream_contract","Chosen output no longer fits a declared downstream input.");
    let before:number|null=null,after:number|null=null;
    const price=async (graph:CompiledDag):Promise<number|null>=>{
      if (graph.nodes.some(item=>item.type === "LLMTask" && !ModelAliasSchema.safeParse(item.config.model_alias).success)) return null;
      const estimate=await this.estimator.estimate({tenantId,compiledDag:graph});
      return estimate.unpricedCalls === 0 ? estimate.billableMinor : null;
    };
    try {
      after=await price(proposed);
      if (previousChoice) before=await price({...proposed,nodes:proposed.nodes.map(item=>item.key === node.key ? {...item,config:applyNodeOverride(item.config,previousChoice)} : item)});
    } catch { /* Advice remains available when the cost service cannot price a run. */ }
    if (before === null || after === null) warn("cost_unavailable","Complete D4 prices are unavailable for this comparison.");
    else if (overrideCostIsMaterial(before,after,this.thresholds)) warn("cost","Estimated maximum cost per run rises by both configured materiality thresholds.");
    return NodeOverrideComparisonSchema.parse({nodeKey:node.key,choice,approval_required:approvalRequired,original:{choice:previousChoice,selection},candidate,warnings,cost:{currency:"INR",before_minor:before,after_minor:after},validation:{valid:validation.success,errors},data_contract:dataContract});
  }
}
