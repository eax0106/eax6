import * as React from "react"
import { useParams, Link, useNavigate } from "react-router-dom"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, ExternalLink, Workflow, Folder, Terminal, Loader2 } from "lucide-react"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import { Composer } from "@/components/conversation/Composer"
import { MessageList } from "@/components/conversation/MessageList"
import { ClarificationQuestions } from "@/components/conversation/clarification-questions"
import { Button } from "@/components/ui/button"

export function ConversationDetail() {
  const { conversationId } = useParams<{ conversationId: string }>()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const createDraft = useMutation({
    mutationFn: () => api.createConversationDraft(conversationId!),
    onSuccess: chat => navigate(`/app/conversations/${chat.id}`),
  })
  const scrollRef = React.useRef<HTMLDivElement>(null)

  const { data: conversation, isLoading: isLoadingConv, error: conversationError } = useQuery({
    queryKey: queryKeys.conversations.detail(conversationId!),
    queryFn: () => api.getConversation(conversationId!),
    enabled: !!conversationId
  })

  const { data: messages, isLoading: isLoadingMsgs, error: messagesError } = useQuery({
    queryKey: queryKeys.conversations.messages(conversationId!),
    queryFn: () => api.getConversationMessages(conversationId!),
    enabled: !!conversationId
  })

  const sendMessage = useMutation({
    mutationFn: (content: string) => api.sendMessage(conversationId!, { content }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.messages(conversationId!) })
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.list() })
    }
  })

  // Auto-scroll to bottom
  React.useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  if (isLoadingConv || isLoadingMsgs) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (conversationError || messagesError) return <div role="alert" className="p-6 text-destructive">{(conversationError ?? messagesError)?.message}</div>

  if (!conversation) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Conversation not found.
      </div>
    )
  }

  // Map ConversationMessage to ChatMessage for the existing MessageList component
  const mappedMessages = (messages || []).map(m => ({
    id: m.id,
    role: m.role as any,
    type: m.kind as any,
    content: typeof m.content === "string" ? m.content : typeof m.content.text === "string" ? m.content.text : JSON.stringify(m.content),
    data: m.content,
    createdAt: m.createdAt
  }))

  const renderCustomMessage = (msg: any) => {
    const data = msg.data
    if (msg.type === "clarification" && Array.isArray(data.questions)) {
      return <div><p>{msg.content}</p><ClarificationQuestions
        questions={data.questions.map((question: string) => ({ id: question, question }))}
        pending={sendMessage.isPending}
        onSubmit={answers => sendMessage.mutate(Object.entries(answers).map(([question, answer]) => `${question}: ${answer}`).join("\n"))}
      /></div>
    }
    if (msg.type === "workflow" && data.workflowId) {
      return <div><p>{msg.content}</p><Link to={`/app/workflows/${data.workflowId}`} className="text-primary">Open workflow</Link></div>
    }
    if (msg.type === "action") {
      return (
        <div className="space-y-3">
          <p>{data.text}</p>
          <div className="flex flex-wrap gap-2">
            {data.actions.map((action: any, i: number) => (
              <Button key={i} variant="outline" size="sm" asChild>
                <Link to={action.href}>{action.label}</Link>
              </Button>
            ))}
          </div>
        </div>
      )
    }
    if (msg.type === "run") {
      return (
        <div className="space-y-2 rounded-lg border border-border bg-surface-raised p-3">
          <div className="font-medium">{data.summary}</div>
          {data.error && <div className="text-sm text-destructive">{data.error}</div>}
          {data.recommendation && <div className="text-sm text-muted-foreground">{data.recommendation}</div>}
          {data.runId && (
            <Button variant="outline" size="sm" className="mt-2" asChild>
              <Link to={`/app/runs/${data.runId}`}>View Run Details <ExternalLink className="ml-2 h-3 w-3" /></Link>
            </Button>
          )}
        </div>
      )
    }
    return <p className="whitespace-pre-wrap">{msg.content}</p>
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="flex h-14 items-center gap-4 border-b border-border bg-surface-base px-4 shrink-0">
          <Button variant="ghost" size="icon" asChild className="md:hidden">
            <Link to="/app/conversations">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="font-medium truncate">{conversation.title}</div>
          {conversation.type === "general" && <Button size="sm" onClick={() => createDraft.mutate()} disabled={createDraft.isPending}>Create draft workflow</Button>}
        </header>

        <div className="flex-1 overflow-auto p-4 md:p-6" ref={scrollRef}>
          <div className="mx-auto max-w-3xl">
            <MessageList 
              messages={mappedMessages} 
              renderCustomMessage={renderCustomMessage} 
            />
          </div>
        </div>

        <div className="shrink-0 p-4 bg-surface-base border-t border-border">
          <div className="mx-auto max-w-3xl">
            {(sendMessage.isError || createDraft.isError) && <p role="alert" className="mb-2 text-sm text-destructive">{(sendMessage.error ?? createDraft.error)?.message}</p>}
            {conversation.status === "archived" ? <p>Chat archived.</p> : <Composer 
              onSend={(msg) => sendMessage.mutate(msg)} 
              loading={sendMessage.isPending}
            />}
          </div>
        </div>
      </div>

      {/* Context Panel */}
      {(conversation.linkedWorkflowId || conversation.linkedProjectId || conversation.linkedRunId) && (
        <div className="hidden lg:block w-80 border-l border-border bg-surface-base overflow-auto p-6">
          <h3 className="text-sm font-medium mb-4">Context</h3>
          
          <div className="space-y-3">
            {conversation.linkedWorkflowId && (
              <Link to={`/app/workflows/${conversation.linkedWorkflowId}`} className="block group">
                <div className="p-3 rounded-lg border border-border hover:border-primary/50 transition-colors">
                  <div className="flex items-center gap-2 mb-1 text-primary">
                    <Workflow className="h-4 w-4" />
                    <span className="text-sm font-medium">Workflow</span>
                  </div>
                  <div className="text-xs text-muted-foreground break-all">{conversation.linkedWorkflowId}</div>
                </div>
              </Link>
            )}
            
            {conversation.linkedProjectId && (
              <Link to={`/app/projects/${conversation.linkedProjectId}`} className="block group">
                <div className="p-3 rounded-lg border border-border hover:border-primary/50 transition-colors">
                  <div className="flex items-center gap-2 mb-1 text-primary">
                    <Folder className="h-4 w-4" />
                    <span className="text-sm font-medium">Project</span>
                  </div>
                  <div className="text-xs text-muted-foreground break-all">{conversation.linkedProjectId}</div>
                </div>
              </Link>
            )}

            {conversation.linkedRunId && (
              <Link to={`/app/runs/${conversation.linkedRunId}`} className="block group">
                <div className="p-3 rounded-lg border border-border hover:border-primary/50 transition-colors">
                  <div className="flex items-center gap-2 mb-1 text-primary">
                    <Terminal className="h-4 w-4" />
                    <span className="text-sm font-medium">Run</span>
                  </div>
                  <div className="text-xs text-muted-foreground break-all">{conversation.linkedRunId}</div>
                </div>
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
