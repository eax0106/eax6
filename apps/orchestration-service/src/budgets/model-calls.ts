import type { CompiledDag, ModelAlias } from "@alterx/contracts";
import { ModelAliasSchema } from "@alterx/contracts";

/** The alias the Synthesis handler always uses. */
const SYNTHESIS_ALIAS: ModelAlias = "ADVANCED";

/**
 * The model calls a compiled workflow can make: one per LLMTask (the alias its
 * config names) and one per Synthesis. A node whose alias is missing or
 * unknown cannot run, so it is left out rather than guessed.
 */
export function modelCallsOf(dag: CompiledDag): readonly { readonly nodeKey: string; readonly alias: ModelAlias }[] {
  const calls: { nodeKey: string; alias: ModelAlias }[] = [];
  for (const node of dag.nodes) {
    if (node.type === "Synthesis") {
      calls.push({ nodeKey: node.key, alias: SYNTHESIS_ALIAS });
    } else if (node.type === "LLMTask") {
      const alias = ModelAliasSchema.safeParse((node.config as Record<string, unknown>)["model_alias"]);
      if (alias.success) calls.push({ nodeKey: node.key, alias: alias.data });
    }
  }
  return calls;
}
