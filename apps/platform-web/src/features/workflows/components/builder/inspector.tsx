import { ApprovalPolicyControls } from "../approval-policy-controls"
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

        <div className="space-y-4">
          <h4 className="text-sm font-medium">Configuration</h4>
          
          <div className="space-y-2">
            <Label>Label</Label>
            <Input 
              value={String(node.data.label || "")} 
              onChange={(e) => updateNodeData(node.id, { label: e.target.value })}
            />
          </div>

          {nodeDef?.configSchema && Object.entries(nodeDef.configSchema).map(([key, schema]: [string, any]) => (
            <div key={key} className="space-y-2">
              <Label>{schema.label || key}</Label>
              <Input 
                value={String(node.data[key] || schema.default || "")}
                onChange={(e) => updateNodeData(node.id, { [key]: e.target.value })}
              />
            </div>
          ))}

          {(!nodeDef?.configSchema || Object.keys(nodeDef.configSchema).length === 0) && (
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
