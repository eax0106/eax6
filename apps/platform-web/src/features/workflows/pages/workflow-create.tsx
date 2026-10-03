import * as React from "react"
import { useNavigate } from "react-router-dom"
import { Sparkles, Loader2, Network } from "lucide-react"
import { Composer } from "@/components/conversation/Composer"
import { MessageList } from "@/components/conversation/MessageList"
import { ClarificationQuestions } from "@/components/conversation/clarification-questions"
import { SuggestionCard } from "@/components/conversation/SuggestionCard"
import { StructuredArtifactMessage } from "@/components/conversation/StructuredArtifactMessage"
import { useMutation } from "@tanstack/react-query"
import { api } from "@/api/client"
import type { ConnectionsRequired } from "@alterx/contracts";
import { Button } from "@/components/ui/button";
import { WorkflowPlanCard } from "@/components/conversation/workflow-plan";
import { type ChatMessage } from "@/api/types"

export function WorkflowCreate() {
  const navigate = useNavigate()
  const [messages, setMessages] = React.useState<ChatMessage[]>([])
  // The objective the planner is working on, kept out of the chat log: an
  // answer to a clarification is not a new goal, and re-planning has to send
  // the original objective back with the answers attached. The workflow id
  // keeps those re-plans on the draft that raised the questions.
  const [objective, setObjective] = React.useState("")
  const [answers, setAnswers] = React.useState<Record<string, string>>({})
  const [workflowId, setWorkflowId] = React.useState<string | undefined>(undefined)
  const [confirmedCriteria, setConfirmedCriteria] = React.useState<string[] | undefined>()

  const compileMutation = useMutation({
    mutationFn: api.compileWorkflow,
    onSuccess: (data) => {
      setWorkflowId(data.workflow.id)
      setMessages(prev => [
        ...prev,
        data.plan ? { id: `msg_${Date.now()}`, role: "assistant" as const, type: "workflow_plan" as const,
          content: data.explanation, data: data.plan, createdAt: new Date().toISOString() }
        : data.missingConnections
          ? {
              id: `msg_${Date.now()}`,
              role: "assistant" as const,
              type: "connections_required" as const,
              content: data.explanation,
              data: data.missingConnections,
              createdAt: new Date().toISOString()
            }
          : data.questions.length > 0
          ? {
              id: `msg_${Date.now()}`,
              role: "assistant" as const,
              type: "clarification" as const,
              content: data.explanation,
              data: { questions: data.questions },
              createdAt: new Date().toISOString()
            }
          : {
              id: `msg_${Date.now()}`,
              role: "assistant" as const,
              type: "workflow_draft" as const,
              content: data.explanation,
              data: data.workflow,
              createdAt: new Date().toISOString()
            }
      ])
    }
  })

  const suggestions = [
    "Route urgent support emails to Slack",
    "Research new leads and score them automatically",
    "Review invoices and request approval above $5,000",
    "Monitor failed deployments and create incident reports"
  ]

  const handleSend = (text: string) => {
    setMessages(prev => [
      ...prev,
      {
        id: `msg_u_${Date.now()}`,
        role: "user",
        type: "text",
        content: text,
        createdAt: new Date().toISOString()
      }
    ])

    setObjective(text)
    setAnswers({})
    setConfirmedCriteria(undefined)
    compileMutation.mutate({ goal: text, answers: {} })
  }

  const handleAnswers = (newAnswers: Record<string, string>) => {
    const accumulatedAnswers = { ...answers, ...newAnswers }
    setAnswers(accumulatedAnswers)
    setMessages(prev => [
      ...prev,
      {
        id: `msg_u_${Date.now()}`,
        role: "user",
        type: "text",
        content: Object.entries(newAnswers)
          .map(([question, answer]) => `${question} ${answer}`)
          .join("\n"),
        createdAt: new Date().toISOString()
      }
    ])
    // The same objective and the same draft, now with the answers attached:
    // the planner asked about this goal, not about a new one.
    compileMutation.mutate({ goal: objective, answers: accumulatedAnswers, workflowId,
      ...(confirmedCriteria !== undefined ? { confirm: true, successCriteria: confirmedCriteria } : {}) })
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col bg-surface">
      <div className="border-b border-border bg-surface px-6 py-4">
        <h1 className="text-xl font-semibold">Create Workflow</h1>
        <p className="text-sm text-muted-foreground">Describe what you want to automate</p>
      </div>
      
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl space-y-6">
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center pt-20">
              <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Sparkles className="h-8 w-8" />
              </div>
              <h2 className="mb-8 text-2xl font-semibold">What do you want to automate?</h2>
              <div className="grid w-full grid-cols-2 gap-4">
                {suggestions.map((s, i) => (
                  <SuggestionCard key={i} title={s} onClick={() => handleSend(s)} />
                ))}
              </div>
            </div>
          ) : (
            <MessageList
              messages={messages}
              renderCustomMessage={(msg) => {
                if (msg.type === "clarification") {
                  const answered = messages.indexOf(msg) < messages.length - 1
                  return (
                    <div className="space-y-2">
                      <p>{msg.content}</p>
                      {answered ? (
                        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                          {(msg.data.questions as string[]).map((question) => (
                            <li key={question}>{question}</li>
                          ))}
                        </ul>
                      ) : (
                        <ClarificationQuestions
                          questions={(msg.data.questions as string[]).map((question) => ({
                            id: question,
                            question,
                          }))}
                          onSubmit={handleAnswers}
                          pending={compileMutation.isPending}
                          submitLabel="Answer and plan again"
                        />
                      )}
                    </div>
                  )
                }
                if (msg.type === "workflow_plan") return <WorkflowPlanCard plan={msg.data} pending={compileMutation.isPending}
                  disabled={messages.slice(messages.indexOf(msg) + 1).some(message => message.type === "workflow_draft" || message.type === "workflow_plan")}
                  onBuild={successCriteria => { setConfirmedCriteria(successCriteria); compileMutation.mutate({ goal: objective, answers, workflowId, confirm: true, successCriteria }) }} />
                if (msg.type === "connections_required") {
                  const batch = msg.data as ConnectionsRequired["missing_connections"]
                  const latest = messages.indexOf(msg) === messages.length - 1
                  return (
                    <div className="space-y-3">
                      <p>{msg.content}</p>
                      <ul className="list-disc pl-5">
                        {batch.map(gap => <li key={gap.connector_type}>{gap.connector_type} — {gap.reason === "unavailable" ? "Reconnect account" : "Connect account"}</li>)}
                      </ul>
                      {latest && <div className="flex items-center gap-4">
                        <a className="text-primary underline" href="/app/connections" target="_blank" rel="noreferrer">Open connections in new tab</a>
                        <Button disabled={compileMutation.isPending} onClick={() => compileMutation.mutate({ goal: objective, answers, workflowId, ...(confirmedCriteria ? { confirm: true, successCriteria: confirmedCriteria } : {}) })}>Check connections and plan again</Button>
                      </div>}
                    </div>
                  )
                }
                if (msg.type === "workflow_draft") {
                  return (
                    <div className="space-y-2">
                      <p>{msg.content}</p>
                      <StructuredArtifactMessage
                        title="Workflow ready for review"
                        subtitle={msg.data.name}
                        content={
                          <div className="flex items-center gap-4 py-2">
                            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                              <Network className="h-5 w-5" />
                            </div>
                            <div>
                              <p className="font-medium text-foreground">Draft Generated</p>
                              <p className="text-muted-foreground">Click below to open the builder.</p>
                            </div>
                          </div>
                        }
                        primaryActionLabel="Open builder"
                        onPrimaryAction={() => navigate(`/app/workflows/${msg.data.id}/build`)}
                      />
                    </div>
                  )
                }
                return null
              }}
            />
          )}

          {compileMutation.isError && <p role="alert">{compileMutation.error.message}</p>}
          {compileMutation.isPending && (
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              Generating workflow...
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-border bg-surface p-4">
        <div className="mx-auto max-w-3xl">
          <Composer 
            onSend={handleSend} 
            loading={compileMutation.isPending} 
            disabled={messages[messages.length - 1]?.type === "connections_required" || messages[messages.length - 1]?.type === "clarification" || messages[messages.length - 1]?.type === "workflow_draft" || messages[messages.length - 1]?.type === "workflow_plan"}
          />
        </div>
      </div>
    </div>
  )
}
