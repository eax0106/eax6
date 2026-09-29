import { useState } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { formatDistanceToNow } from "date-fns"
import { ArrowLeft, RefreshCw, Trash2, } from "lucide-react"

import { PageHeader } from "@/components/common/page-header"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import { DocumentList } from "../components/document-list"
export function SourceDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  
  const [activeTab, setActiveTab] = useState("documents")

  const { data: source, isLoading } = useQuery({
    queryKey: queryKeys.knowledge.sources.detail(id!),
    queryFn: () => api.getKnowledgeSource(id!),
    enabled: !!id
  })

  const syncMutation = useMutation({
    mutationFn: () => api.syncKnowledgeSource(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.sources.detail(id!) })
    }
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteKnowledgeSource(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.sources.list })
      navigate("/app/knowledge/sources")
    }
  })

  if (isLoading || !source) {
    return <div className="p-8">Loading source details...</div>
  }

  return (
    <div className="flex-1 p-8 overflow-y-auto">
      <Button variant="ghost" onClick={() => navigate("/app/knowledge/sources")} className="mb-4">
        <ArrowLeft className="mr-2 h-4 w-4" /> Back to Sources
      </Button>

      <PageHeader 
        title={source.name}
        description={`${source.type.replace('_', ' ')} source created ${formatDistanceToNow(new Date(source.createdAt), { addSuffix: true })}`}
        primaryAction={
          <div className="flex gap-2">
            <Button 
              variant="outline" 
              onClick={() => syncMutation.mutate()} 
              disabled={syncMutation.isPending || source.status === 'syncing' || source.status === 'processing'}
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${syncMutation.isPending || source.status === 'syncing' ? 'animate-spin' : ''}`} />
              Sync Now
            </Button>
            <Button 
              variant="danger" 
              onClick={() => {
                if (window.confirm(`Delete "${source.name}" and every document ingested through it? This cannot be undone.`)) {
                  deleteMutation.mutate()
                }
              }}
              disabled={deleteMutation.isPending}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mt-6">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Documents</CardDescription>
            <CardTitle className="text-3xl">{source.documentCount}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Vector Chunks</CardDescription>
            <CardTitle className="text-3xl">{source.chunkCount}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Last Synced</CardDescription>
            <CardTitle className="text-lg">
              {source.lastSyncedAt ? formatDistanceToNow(new Date(source.lastSyncedAt), { addSuffix: true }) : "Never"}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Next Scheduled Sync</CardDescription>
            <CardTitle className="text-lg">
              {source.nextSyncAt ? formatDistanceToNow(new Date(source.nextSyncAt), { addSuffix: true }) : "Manual"}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="mt-8">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="documents">Documents</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>
          
          <TabsContent value="documents" className="mt-6">
            <DocumentList 
              sourceId={source.id} 
              onSelectDocument={(doc) => {
                // In a real app this might open a drawer to view chunks for this specific document
                console.log("Selected doc:", doc)
              }} 
            />
          </TabsContent>
          
          <TabsContent value="settings" className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle>Source Configuration</CardTitle>
                <CardDescription>Manage how this source ingests and chunks data.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="p-4 border rounded-md text-sm text-muted-foreground bg-muted/20">
                  Settings are mocked for this phase. In a complete implementation, chunk size, overlap, and sync schedules would be configurable here.
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
