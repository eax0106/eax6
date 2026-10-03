import { ApprovalPolicyControls } from "../approval-policy-controls"
import { NodeOverrideControls } from "./node-override-controls"
import { X, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { useBuilderStore } from "../../stores/useBuilderStore"
import { useQuery } from "@tanstack/react-query"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"

export function Inspector() {
  const { workflowId, selectedNodeId, nodes, setInspectorOpen, updateNodeData, onNodesChange } = useBuilderStore()

  const { data: nodeTypes } = useQuery({
    queryKey: queryKeys.nodeTypes.all,
    queryFn: () => api.getNodeTypes(),
  })

  const node = nodes.find(n => n.id === selectedNodeId)
  const nodeDef = nodeTypes?.find(nt => nt.type === node?.type)
  const configFields = (nodeDef?.configSchema as any)?.properties ?? nodeDef?.configSchema

  if (!node) {
    return null
  }

  const handleDelete = () => {
    onNodesChange([{ type: "remove", id: node.id }])
  }

  return (
    <div className="flex h-full w-80 flex-col border-l border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border p-4">
        <div>
          <h3 className="font-semibold">{String(node.data.label || "Node")}</h3>
          <p className="text-xs text-muted-foreground">{nodeDef?.name || node.type}</p>
        </div>
        <Button variant="ghost" size="icon" onClick={() => setInspectorOpen(false)}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {nodeDef?.description && (
          <p className="text-sm text-muted-foreground">{nodeDef.description}</p>
        )}

        {node.type === "HumanApproval" && workflowId && <ApprovalPolicyControls workflowId={workflowId} nodeKey={node.id} />}
        {(node.type === "LLMTask" || node.type === "ToolCall") && workflowId && <NodeOverrideControls key={node.id} workflowId={workflowId} nodeKey={node.id} />}

        <div className="space-y-4">
          <h4 className="text-sm font-medium">Configuration</h4>
          
          <div className="space-y-2">
            <Label>Label</Label>
            <Input 
              value={String(node.data.label || "")} 
              onChange={(e) => updateNodeData(node.id, { label: e.target.value })}
            />
          </div>

          {configFields && Object.entries(configFields).filter(([key]) =>
            !(node.type === "LLMTask" && key === "model_alias") && !(node.type === "ToolCall" && key === "tool_name")).map(([key, schema]: [string, any]) => (
            <div key={key} className="space-y-2">
              <Label htmlFor={`node-config-${key}`}>{schema.label || key}</Label>
              {schema.type === "object" || schema.type === "array" ? <>
                <textarea id={`node-config-${key}`} className="w-full rounded border border-border bg-surface p-2 text-sm" rows={4}
                  value={typeof node.data[key] === "string" ? node.data[key] : JSON.stringify(node.data[key] ?? schema.default ?? (schema.type === "array" ? [] : {}), null, 2)}
                  onChange={event => { let value:unknown=event.target.value; try { value=JSON.parse(event.target.value) } catch { /* Retain the invalid text so validation can report it. */ } updateNodeData(node.id,{[key]:value}) }} />
                {typeof node.data[key] === "string" && <p role="alert">Enter valid {schema.type} JSON.</p>}
              </> : <Input id={`node-config-${key}`} type={schema.type === "number" || schema.type === "integer" ? "number" : "text"}
                value={String(node.data[key] ?? schema.default ?? "")}
                onChange={(event) => updateNodeData(node.id, { [key]: schema.type === "number" || schema.type === "integer" ? Number(event.target.value) : event.target.value })}
              />}
            </div>
          ))}

          {(!configFields || Object.keys(configFields).length === 0) && (
            <p className="text-xs text-muted-foreground italic">No configuration required.</p>
          )}
        </div>
      </div>

      <div className="border-t border-border p-4">
        <Button variant="outline" className="w-full text-destructive hover:text-destructive hover:bg-destructive/10" onClick={handleDelete}>
          <Trash2 className="mr-2 h-4 w-4" />
          Delete Node
        </Button>
      </div>
    </div>
  )
}
