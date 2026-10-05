import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { PageHeader } from "@/components/common/page-header"
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { api } from "@/api/client"
import { isLiveApi } from "@/api/http"
import { queryKeys } from "@/api/query-keys"
import { usePermissions } from "@/features/permissions/hooks/usePermissions"
import type { BillingPlan } from "@/api/types"
import { formatProviderMoney,hostedCheckoutUrl } from "../provider-pricing"

const terminalStatuses=['cancelled','completed','expired']
export function BillingPlansPage() {
  const queryClient = useQueryClient(),{role}=usePermissions(),owner=role==="owner"
  const [gstin,setGstin]=useState("")
  const plans = useQuery({ queryKey: queryKeys.billing.plans, queryFn: () => api.billing.getPlans() })
  const subscription = useQuery({ queryKey: queryKeys.billing.subscription, queryFn: () => api.billing.getSubscription() })
  const gstinValid=!gstin || /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)
  const existing=subscription.data&&!terminalStatuses.includes(subscription.data.status)
  const purchase=useMutation({
    mutationFn:(plan:BillingPlan)=>existing
      ?api.billing.changePlan(plan.id,plan.version,subscription.data?.etag)
      :api.billing.subscribe(plan.id,plan.version,gstin||undefined),
    onSuccess:()=>{void queryClient.invalidateQueries({queryKey:queryKeys.billing.subscription})},
  })
  const checkoutState=subscription.data??purchase.data
  const checkout=checkoutState && ["created","authenticated"].includes(checkoutState.status) ? hostedCheckoutUrl(checkoutState.checkoutUrl) : null
  const pending=Boolean(subscription.data?.pendingOperation)
  if(plans.isLoading||subscription.isLoading)return <div className="p-8 text-muted-foreground animate-pulse">Loading plans...</div>
  return <div className="space-y-8">
    <PageHeader title="Subscription Plans" description={isLiveApi?"Configured subscription prices. Checkout adds 18% GST; gateway fees are included.":"Demo catalog. Paid prices await launch configuration."}/>
    {(plans.isError||subscription.isError)&&<div role="alert" className="space-y-2 text-destructive">
      <p>{plans.error?.message??subscription.error?.message}</p>
      <Button variant="outline" onClick={()=>{void plans.refetch();void subscription.refetch()}}>Refresh billing status</Button>
    </div>}
    {!owner&&<p className="text-muted-foreground">Only the tenant owner can change billing.</p>}
    <div className="max-w-sm space-y-2"><label htmlFor="billing-gstin">GSTIN (optional)</label>
      <Input id="billing-gstin" value={gstin} maxLength={15} onChange={event=>setGstin(event.target.value.trim().toUpperCase())} aria-invalid={!gstinValid}/>
      {!gstinValid&&<p role="alert" className="text-destructive">Enter a valid 15-character GSTIN.</p>}
    </div>
    {purchase.isError&&<div role="alert" className="space-y-2 text-destructive"><p>{purchase.error.message}</p>
      <Button variant="outline" onClick={()=>void subscription.refetch()}>Refresh billing status</Button></div>}
    {checkout&&<div className="space-y-2"><a className="text-primary underline" href={checkout} target="_blank" rel="noopener noreferrer">Continue secure Razorpay checkout</a>
      <p className="text-sm text-muted-foreground">Paid access starts after Razorpay confirms activation.</p>
      <Button variant="outline" onClick={()=>void subscription.refetch()}>Refresh billing status</Button></div>}
    {pending&&<p role="status">{subscription.data?.pendingOperation==="change"?`Plan change to ${subscription.data.pendingPlan} awaits provider confirmation.`:"Cancellation awaits provider confirmation."}</p>}
    {plans.data?.length===0&&<p>No plans are available.</p>}
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">{plans.data?.map(plan=>{
      const current=existing&&subscription.data?.planId===plan.id
      const free=plan.id==="free",price=plan.checkout
      return <Card key={plan.id} className={current?"border-primary":""}>
        <CardHeader><CardTitle className="capitalize">{plan.name}{current?" — Current":""}</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {free?<p className="text-3xl font-bold">Free</p>:price?<>
            <p className="text-3xl font-bold">{formatProviderMoney(price.basePriceMinor,price.currency)} <span className="text-sm font-normal">per billing cycle</span></p>
            <p>GST ({price.gstPercent}%): {formatProviderMoney(price.gstMinor,price.currency)}</p>
            <p className="font-semibold">Total: {formatProviderMoney(price.totalMinor,price.currency)}</p>
            <p>{plan.commercial?.includedCredits} credits per paid cycle</p>
          </>:<p>Price unavailable until launch configuration is set.</p>}
          <p>{plan.limits.maxRunsPerDay} runs per day</p>
          {free?<p className="text-sm text-muted-foreground">Verified email required.</p>:plan.commercial?.creditsPerVerifiedRun!=null&&<p>{plan.commercial.creditsPerVerifiedRun} credits per verified run. Failed or incomplete runs consume no credits.</p>}
        </CardContent>
        <CardFooter><Button className="w-full" disabled={free||current||!price||!owner||!gstinValid||subscription.isError||purchase.isPending||pending||Boolean(existing&&['created','pending','halted','paused'].includes(subscription.data!.status))}
          onClick={()=>{if(price&&window.confirm(`Choose ${plan.name} for ${formatProviderMoney(price.totalMinor,price.currency)} including 18% GST per billing cycle?`))purchase.mutate(plan)}}>
          {free?"Free tier":current?"Current plan":!price?"Unavailable":existing?"Change plan":"Start checkout"}
        </Button></CardFooter>
      </Card>
    })}</div>
  </div>
}
