import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Loader2, Link as LinkIcon, Key, CheckCircle2 } from "lucide-react"

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api } from "@/api/client"
import { isLiveApi } from "@/api/http"
import { queryKeys } from "@/api/query-keys"
import { type IntegrationDefinition } from "@/api/types"

interface ConnectFlowDialogProps {
  integration: IntegrationDefinition | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ConnectFlowDialog({ integration, open, onOpenChange }: ConnectFlowDialogProps) {
  const queryClient = useQueryClient()
  const [step, setStep] = React.useState<"initial" | "auth" | "success">("initial")
  const [name, setName] = React.useState("")
  const [apiKey, setApiKey] = React.useState("")
  const [config, setConfig] = React.useState("")
  const configField = integration ? ({ zendesk: "subdomain", salesforce: "login_host", shopify: "shop_domain", m365: "tenant" } as Record<string, string>)[integration.id] : undefined

  React.useEffect(() => {
    if (open && integration) {
      setStep("initial")
      setName(`${integration.name} Connection`)
      setApiKey("")
      setConfig("")
    }
  }, [open, integration])

  const mutation = useMutation({
    mutationFn: () => {
      return api.createConnection({
        integrationId: integration!.id,
        name,
        ...(isLiveApi && configField ? { tenantConfig: { [configField]: config } } : {}),
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.connections.list })
      setStep(isLiveApi ? "auth" : "success")
    }
  })

  if (!integration) return null

  const handleConnect = () => {
    if (!isLiveApi && integration.authType === "oauth") {
      // Simulate OAuth redirect
      setTimeout(() => {
        mutation.mutate()
      }, 1000)
    } else {
      mutation.mutate()
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        {step === "initial" && (
          <>
            <DialogHeader>
              <DialogTitle>Connect {integration.name}</DialogTitle>
              <DialogDescription>
                Configure the connection settings to link {integration.name} to AlterX.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              {!isLiveApi && <div className="space-y-2">
                <Label>Connection Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </div>}
              {isLiveApi && configField && <label className="block space-y-2">
                <span>{({ subdomain: "Zendesk subdomain", login_host: "Salesforce login host", shop_domain: "Shopify shop domain", tenant: "Microsoft tenant UUID or common" } as Record<string, string>)[configField]}</span>
                <Input value={config} onChange={event => setConfig(event.target.value)} required />
              </label>}
              {isLiveApi && !integration.available && <p role="alert">This integration is not configured. Ask your administrator to set it up.</p>}
              {mutation.isError && <p role="alert">Connection authorization failed. Check your settings and try again.</p>}
              {integration.authType === "api_key" && (
                <div className="space-y-2">
                  <Label>API Key</Label>
                  <Input 
                    type="password" 
                    placeholder="Enter API key" 
                    value={apiKey} 
                    onChange={(e) => setApiKey(e.target.value)} 
                  />
                  <p className="text-xs text-muted-foreground">Keys are stored securely in the credentials vault.</p>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={handleConnect} disabled={mutation.isPending || (isLiveApi && (!integration.available || Boolean(configField && !config.trim())))}>
                {mutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : integration.authType === "oauth" ? (
                  <LinkIcon className="mr-2 h-4 w-4" />
                ) : (
                  <Key className="mr-2 h-4 w-4" />
                )}
                {integration.authType === "oauth" ? "Connect via OAuth" : "Save Connection"}
              </Button>
            </DialogFooter>
          </>
        )}

        {step === "auth" && <p role="status">Opening provider authorization…</p>}

        {step === "success" && (
          <div className="py-6 text-center space-y-4">
            <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto" />
            <DialogTitle>Successfully Connected</DialogTitle>
            <DialogDescription>
              {name} is now connected and ready to use in your workflows and agents.
            </DialogDescription>
            <Button className="mt-4 w-full" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
