import { ModelAliasSchema, ToolNameSchema, type CompiledDag, type NodeOverrideChoice } from "@alterx/contracts";

export function originalChoice(node: CompiledDag["nodes"][number] | undefined): NodeOverrideChoice | undefined {
  if (!node) return undefined;
  if (node.metadata.original_choice) return node.metadata.original_choice;
  const alias=ModelAliasSchema.safeParse(node.metadata.selection_binding?.model_alias ?? node.config.model_alias);
  if (node.type === "LLMTask" && alias.success) return {kind:"model",value:alias.data};
  const tool=ToolNameSchema.safeParse(node.metadata.selection_binding?.tool_name ?? node.config.tool_name);
  if (node.type === "ToolCall" && tool.success) return {kind:"tool",value:tool.data};
  return undefined;
}

/** Compiler evidence comes from stored versions, including on ordinary canvas writes. */
export function preserveOriginalSelections(dag: CompiledDag, stored: CompiledDag | undefined): CompiledDag {
  const originals=new Map(stored?.nodes.map(node=>[node.key,node]));
  return {...dag,nodes:dag.nodes.map(node=>{
    const previous=originals.get(node.key);
    const source=previous?.type === node.type ? previous : undefined;
    const metadata={...node.metadata}; delete metadata.selection_binding; delete metadata.original_choice; delete metadata.override_safeguards;
    const choice=originalChoice(source);
    return {...node,metadata:{...metadata,
      ...(source?.metadata.selection_binding ? {selection_binding:source.metadata.selection_binding} : {}),
      ...(choice ? {original_choice:choice} : {}),
    }};
  })};
}
