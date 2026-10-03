import { create } from "zustand"
import { 
  type Node, 
  type Edge, 
  type OnNodesChange, 
  type OnEdgesChange, 
  type OnConnect,
  applyNodeChanges, 
  applyEdgeChanges,
  addEdge
} from "@xyflow/react"

interface BuilderState {
  workflowId?: string
  nodes: Node[]
  edges: Edge[]
  successCriteria: string[] | undefined
  selectedNodeId: string | null
  isDirty: boolean
  inspectorOpen: boolean
  
  setWorkflowId: (id: string) => void
  setNodes: (nodes: Node[]) => void
  setEdges: (edges: Edge[]) => void
  setSuccessCriteria: (criteria: string[] | undefined) => void
  onNodesChange: OnNodesChange<Node>
  onEdgesChange: OnEdgesChange
  onConnect: OnConnect
  setSelectedNodeId: (id: string | null) => void
  setInspectorOpen: (open: boolean) => void
  setDirty: (dirty: boolean) => void
  updateNodeData: (id: string, data: any) => void
}

export const useBuilderStore = create<BuilderState>((set, get) => ({
  workflowId: undefined,
  nodes: [],
  edges: [],
  successCriteria: undefined,
  selectedNodeId: null,
  isDirty: false,
  inspectorOpen: false,

  setWorkflowId: (id) => { if (get().workflowId !== id) set({ workflowId: id, nodes: [], edges: [], successCriteria: undefined, isDirty: false, selectedNodeId: null }) },
  setNodes: (nodes) => set({ nodes, isDirty: true }),
  setEdges: (edges) => set({ edges, isDirty: true }),
  setSuccessCriteria: (successCriteria) => set({ successCriteria }),
  
  onNodesChange: (changes) => {
    set({
      nodes: applyNodeChanges(changes, get().nodes),
      isDirty: true,
    })
    
    // Automatically manage selectedNodeId based on selection changes
    const selectChange = changes.find((c) => c.type === "select")
    if (selectChange && selectChange.type === "select") {
      if (selectChange.selected) {
        set({ selectedNodeId: selectChange.id, inspectorOpen: true })
      } else if (get().selectedNodeId === selectChange.id) {
        set({ selectedNodeId: null, inspectorOpen: false })
      }
    }
    
    // Handle removal of selected node
    const removeChange = changes.find((c) => c.type === "remove")
    if (removeChange && removeChange.type === "remove" && removeChange.id === get().selectedNodeId) {
      set({ selectedNodeId: null, inspectorOpen: false })
    }
  },

  onEdgesChange: (changes) => {
    set({
      edges: applyEdgeChanges(changes, get().edges),
      isDirty: true,
    })
  },

  onConnect: (connection) => {
    set({
      edges: addEdge(connection, get().edges),
      isDirty: true,
    })
  },
  
  setSelectedNodeId: (id) => set({ selectedNodeId: id, inspectorOpen: !!id }),
  setInspectorOpen: (open) => set({ inspectorOpen: open }),
  setDirty: (dirty) => set({ isDirty: dirty }),
  
  updateNodeData: (id, data) => {
    set({
      nodes: get().nodes.map((node) => {
        if (node.id === id) {
          return { ...node, data: { ...node.data, ...data } }
        }
        return node
      }),
      isDirty: true,
    })
  },
}))
