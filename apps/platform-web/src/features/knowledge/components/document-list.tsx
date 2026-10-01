import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { formatDistanceToNow } from "date-fns"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import { type KnowledgeDocument } from "@/api/types"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FileText, FileJson, RefreshCw, AlertCircle, Trash2 } from "lucide-react"

interface DocumentListProps {
  sourceId: string
  onSelectDocument: (doc: KnowledgeDocument) => void
}

export function DocumentList({ sourceId, onSelectDocument }: DocumentListProps) {
  const queryClient = useQueryClient()
  
  const { data: documents, isLoading } = useQuery({
    queryKey: queryKeys.knowledge.documents(sourceId),
    queryFn: () => api.getKnowledgeDocuments(sourceId)
  })

  const retryMutation = useMutation({
    mutationFn: (id: string) => api.retryKnowledgeDocument(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.documents(sourceId) })
    }
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteKnowledgeDocument(id),
    onSuccess: (_, id) => {
      queryClient.removeQueries({ queryKey: queryKeys.knowledge.chunks(sourceId, id) })
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.documents(sourceId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.sources.detail(sourceId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.sources.list })
    },
  })

  if (isLoading) {
    return <div className="p-8 text-center text-muted-foreground">Loading documents...</div>
  }

  if (!documents || documents.length === 0) {
    return (
      <div className="border border-dashed rounded-lg p-12 text-center text-muted-foreground">
        <FileText className="mx-auto h-8 w-8 mb-4 opacity-50" />
        <p>No documents found in this source.</p>
        <p className="text-sm mt-1">Add files or sync integration to ingest data.</p>
      </div>
    )
  }

  return (
    <div className="rounded-md border">
      {deleteMutation.isError && <p role="alert" className="p-4 text-destructive">
        Delete failed: {deleteMutation.error instanceof Error ? deleteMutation.error.message : "Try again."}
      </p>}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Document</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Size</TableHead>
            <TableHead>Chunks</TableHead>
            <TableHead>Added</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {documents.map((doc) => (
            <TableRow key={doc.id} className="cursor-pointer hover:bg-muted/50" onClick={() => onSelectDocument(doc)}>
              <TableCell>
                <div className="flex items-center gap-2 font-medium">
                  {doc.mimeType?.includes("json") ? <FileJson className="h-4 w-4 text-muted-foreground" /> : <FileText className="h-4 w-4 text-muted-foreground" />}
                  {doc.name}
                </div>
              </TableCell>
              <TableCell>
                <div className="flex flex-col gap-1">
                  <Badge variant={doc.status === "failed" ? "danger" : doc.status === "indexed" ? "default" : "secondary"}>
                    {doc.status}
                  </Badge>
                  {doc.error && (
                    <span className="text-xs text-destructive flex items-center gap-1">
                      <AlertCircle className="h-3 w-3" />
                      {doc.error.code}
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {doc.sizeBytes ? (doc.sizeBytes / 1024).toFixed(1) + " KB" : "-"}
              </TableCell>
              <TableCell>
                {doc.chunkCount ?? "-"}
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">
                {formatDistanceToNow(new Date(doc.createdAt), { addSuffix: true })}
              </TableCell>
              <TableCell className="text-right">
                <Button variant="ghost" size="icon" aria-label={`Delete ${doc.name}`} disabled={deleteMutation.isPending}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (window.confirm(`Delete "${doc.name}" and all its indexed content? This cannot be undone.`)) {
                      deleteMutation.mutate(doc.id)
                    }
                  }}>
                  <Trash2 className="h-4 w-4" />
                </Button>
                {doc.status === "failed" && (
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    onClick={(e) => {
                      e.stopPropagation()
                      retryMutation.mutate(doc.id)
                    }}
                  >
                    <RefreshCw className={`h-4 w-4 ${retryMutation.isPending ? "animate-spin" : ""}`} />
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
