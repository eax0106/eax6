import { useRef } from "react"
import { Link, useNavigate } from "react-router-dom"
import { useMutation } from "@tanstack/react-query"
import { Bot, ArrowRight, Zap } from "lucide-react"
import { Composer } from "@/components/conversation/Composer"
import { api } from "@/api/client"
import { cn } from "@/lib/utils"

const INTENT_SUGGESTIONS = [
  { label: "Create a new workflow for support", icon: Zap },
  { label: "Create a weekly reporting workflow", icon: Zap },
]

export function Home() {
  const navigate = useNavigate()
  const draft = useRef<Awaited<ReturnType<typeof api.createConversation>> | null>(null)
  const askAlter = useMutation({
    mutationFn: () => api.createConversation({ type: "general", title: "Ask Alter" }),
    onSuccess: chat => navigate(`/app/conversations/${chat.id}`),
  })

  const startConversation = useMutation({
    mutationFn: async (message: string) => {
      // Create conversation
      const conv = draft.current ?? await api.createConversation({
        type: "workflow_builder",
        title: message.slice(0, 30) + (message.length > 30 ? "..." : "")
      })
      draft.current = conv
      // Send initial message
      await api.sendMessage(conv.id, { content: message })
      return conv
    },
    onSuccess: (data) => {
      navigate(`/app/conversations/${data.id}`)
    }
  })

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 flex flex-col items-center justify-center p-4">
        
        <div className="w-full max-w-2xl flex flex-col items-center animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-6">
            <Bot className="h-8 w-8 text-primary" />
          </div>
          
          <h1 className="text-3xl font-semibold mb-2 text-center text-foreground">
            What do you want to build today?
          </h1>
          <p className="text-muted-foreground mb-8 text-center max-w-md">
            Describe a workflow to create its draft and start building in its chat.
          </p>

          <div className="w-full mb-8">
            <Composer 
              onSend={(msg) => startConversation.mutate(msg)} 
              loading={startConversation.isPending}
              placeholder="Describe what you want to achieve..."
            />
          </div>

          {(startConversation.isError || askAlter.isError) && (
            <div role="alert" className="mb-4 w-full text-sm text-destructive">
              <p>{(startConversation.error ?? askAlter.error)?.message}</p>
              {draft.current && <div className="flex gap-4 mt-2">
                <button onClick={() => startConversation.mutate(startConversation.variables!)} disabled={startConversation.isPending}>Retry in this draft</button>
                <Link to={`/app/conversations/${draft.current.id}`}>Open draft chat</Link>
              </div>}
            </div>
          )}
          <button onClick={() => askAlter.mutate()} disabled={askAlter.isPending} className="mb-6 text-sm text-primary">
            Ask Alter about your workflows
          </button>

          <div className="w-full grid grid-cols-1 sm:grid-cols-2 gap-3">
            {INTENT_SUGGESTIONS.map((suggestion, i) => (
              <button
                key={i}
                onClick={() => startConversation.mutate(suggestion.label)}
                disabled={startConversation.isPending}
                className={cn(
                  "group flex items-center gap-3 p-3 rounded-xl border border-border bg-surface-base text-left transition-all",
                  "hover:border-primary/50 hover:bg-surface-raised",
                  startConversation.isPending && "opacity-50 pointer-events-none"
                )}
              >
                <div className="h-8 w-8 rounded-lg bg-surface-raised flex items-center justify-center shrink-0">
                  <suggestion.icon className="h-4 w-4 text-muted-foreground" />
                </div>
                <span className="text-sm font-medium flex-1">{suggestion.label}</span>
                <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 -translate-x-2 transition-all group-hover:opacity-100 group-hover:translate-x-0" />
              </button>
            ))}
          </div>

        </div>

      </div>
    </div>
  )
}
