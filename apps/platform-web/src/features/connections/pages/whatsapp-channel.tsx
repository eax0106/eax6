import { useId, useRef, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { MessageSquare } from "lucide-react"

import { PageHeader } from "@/components/common/page-header"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api } from "@/api/client"
import { mutationKey } from "@/api/http"
import type { WhatsAppChannel } from "@/api/types"
import { usePermissions } from "@/features/permissions/hooks/usePermissions"
import { queryKeys } from "@/api/query-keys"
import { formatDistanceToNow } from "date-fns"

export function WhatsAppChannelPage() {
  const { can } = usePermissions()
  const { data: channels, isLoading, error } = useQuery({
    queryKey: queryKeys.channels.whatsapp.list,
    queryFn: () => api.getWhatsAppChannels()
  })

  return (
    <div className="flex-1 p-8 overflow-y-auto">
      <PageHeader 
        title="WhatsApp Integration"
        description="Connect conversational agents to WhatsApp numbers."
        primaryAction={
          <Button>Connect Number</Button>
        }
      />

      <div className="mt-8">
        {error && <p role="alert">{error.message}</p>}
        {isLoading ? (
          <div>Loading channels...</div>
        ) : channels && channels.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {channels.map(ch => (
              <Card key={ch.id}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-green-500/10 rounded-md">
                        <MessageSquare className="h-5 w-5 text-green-600" />
                      </div>
                      <div>
                        <CardTitle className="text-base">{ch.name}</CardTitle>
                        <CardDescription className="font-mono mt-1 text-xs">
                          {ch.phoneNumber}
                        </CardDescription>
                      </div>
                    </div>
                    <Badge variant={ch.status === 'connected' ? 'default' : 'secondary'}>
                      {ch.status}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="pt-2 text-sm text-muted-foreground flex justify-between border-t mt-4 pt-4">
                  <span>Provider: <span className="capitalize text-foreground font-medium">{ch.provider}</span></span>
                  {ch.createdAt && !Number.isNaN(Date.parse(ch.createdAt)) && <span>Created {formatDistanceToNow(new Date(ch.createdAt), { addSuffix: true })}</span>}
                </CardContent>
                {can("channel.manage") && ch.status === "connected" && <CardContent><WhatsAppTestForm channel={ch} /></CardContent>}
              </Card>
            ))}
          </div>
        ) : (
          <div className="p-12 border border-dashed rounded-lg text-center text-muted-foreground">
            <MessageSquare className="mx-auto h-12 w-12 opacity-50 mb-4" />
            <p>No WhatsApp channels connected.</p>
          </div>
        )}
      </div>
    </div>
  )
}

function WhatsAppTestForm({ channel }: { channel: WhatsAppChannel }) {
  const id = useId()
  const [recipient, setRecipient] = useState("")
  const [selection, setSelection] = useState("")
  const requestKey = useRef("")
  const templates = useQuery({
    queryKey: [...queryKeys.channels.whatsapp.detail(channel.id), "templates"],
    queryFn: () => api.getWhatsAppTemplates(channel.id),
  })
  const approved = templates.data?.filter(template => template.status === "APPROVED") ?? []
  const selected = approved.find(template => `${template.name}:${template.language}` === selection)
  const send = useMutation({
    mutationFn: () => api.testWhatsAppChannel(channel.id, {
      to: recipient.replace(/^\+/, ""), templateName: selected!.name, languageCode: selected!.language,
    }, requestKey.current),
  })
  function changed() { requestKey.current = ""; send.reset() }

  return <form className="space-y-3" onSubmit={event => {
    event.preventDefault()
    if (!selected || !/^\+?[1-9][0-9]{6,14}$/.test(recipient) || send.isPending || send.isSuccess) return
    if (!window.confirm(`Send template ${selected.name} (${selected.language}) to ${recipient}? This sends a WhatsApp message.`)) return
    requestKey.current ||= mutationKey("whatsapp-test-send")
    send.mutate()
  }}>
    <p className="font-medium">Send test message</p>
    <Label htmlFor={`${id}-recipient`}>Recipient (international number)</Label>
    <Input id={`${id}-recipient`} type="tel" required pattern="\+?[1-9][0-9]{6,14}" placeholder="+15551234567"
      value={recipient} disabled={send.isPending} onChange={event => { setRecipient(event.target.value); changed() }} />
    <Label htmlFor={`${id}-template`}>Approved template</Label>
    <select id={`${id}-template`} className="w-full rounded-md border border-border bg-transparent p-2" required
      value={selection} disabled={templates.isPending || send.isPending} onChange={event => { setSelection(event.target.value); changed() }}>
      <option value="">Select a template</option>
      {approved.map(template => <option key={`${template.name}:${template.language}`} value={`${template.name}:${template.language}`}>
        {template.name} ({template.language})
      </option>)}
    </select>
    {templates.isPending && <p>Loading templates...</p>}
    {templates.error && <p role="alert">{templates.error.message} <Button type="button" variant="ghost" onClick={() => { void templates.refetch() }}>Retry templates</Button></p>}
    {templates.isSuccess && !approved.length && <p>No approved templates available.</p>}
    <Button type="submit" disabled={!selected || !/^\+?[1-9][0-9]{6,14}$/.test(recipient) || send.isPending || send.isSuccess}>
      {send.isPending ? "Sending..." : "Send test message"}
    </Button>
    {send.error && <p role="alert">{send.error.message}</p>}
    {send.data && <p role="status">Message accepted: {send.data.messageId}</p>}
  </form>
}
