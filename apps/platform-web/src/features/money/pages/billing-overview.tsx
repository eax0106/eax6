import { useMutation,useQuery,useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { PageHeader } from "@/components/common/page-header"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { api } from "@/api/client"
import { isLiveApi } from "@/api/http"
import { queryKeys } from "@/api/query-keys"
import { usePermissions } from "@/features/permissions/hooks/usePermissions"
import { CreditPurchaseCard } from "./credit-purchase"
import { formatProviderMoney,hostedCheckoutUrl } from "../provider-pricing"

export function BillingOverviewPage() {
  const navigate = useNavigate(),queryClient=useQueryClient(),{role}=usePermissions()
  const subscription = useQuery({ queryKey: queryKeys.billing.subscription, queryFn: () => api.billing.getSubscription() })
  const plans = useQuery({ queryKey: queryKeys.billing.plans, queryFn: () => api.billing.getPlans() })
  const credits=useQuery({queryKey:queryKeys.billing.credits,queryFn:()=>api.billing.getCredits()})
  const cancel=useMutation({mutationFn:()=>api.billing.cancelSubscription(subscription.data?.etag),
    onSuccess:()=>{void queryClient.invalidateQueries({queryKey:queryKeys.billing.subscription})}})
  if(subscription.isLoading||plans.isLoading)return <div className="p-8 text-muted-foreground animate-pulse">Loading billing...</div>
  const current=subscription.data,plan=plans.data?.find(item=>item.id===current?.planId),checkout=hostedCheckoutUrl(current?.checkoutUrl)
  const terminal=current&&['cancelled','completed','expired'].includes(current.status)
  return <div className="space-y-8">
    <PageHeader title="Billing Overview" description={isLiveApi?"Your subscription and verified-run credits.":"Demo billing. Paid prices await configuration."}/>
    {(subscription.isError||plans.isError)&&<p role="alert" className="text-destructive">{subscription.error?.message??plans.error?.message}</p>}
    <Button variant="outline" onClick={()=>{void subscription.refetch();void credits.refetch()}}>Refresh billing status</Button>
    <div className="grid gap-6 md:grid-cols-2">
      <Card><CardHeader><CardTitle>Subscription</CardTitle></CardHeader><CardContent className="space-y-4">
        {current?<>
          <p className="text-3xl font-bold capitalize">{plan?.name??current.planId}</p><p className="capitalize">{current.status}</p>
          {current.checkoutSnapshot&&<p>{formatProviderMoney(current.checkoutSnapshot.basePriceMinor,current.checkoutSnapshot.currency)} + GST {formatProviderMoney(current.checkoutSnapshot.gstMinor,current.checkoutSnapshot.currency)} = {formatProviderMoney(current.checkoutSnapshot.totalMinor,current.checkoutSnapshot.currency)} per billing cycle</p>}
          {current.gstin&&<p>GSTIN: {current.gstin}</p>}
          {current.currentPeriodEnd&&<p>Current period ends {new Date(current.currentPeriodEnd).toLocaleDateString()}</p>}
          {current.pendingOperation&&<p role="status">{current.pendingOperation==='cancel'?'Cancellation':'Plan change'} awaits provider confirmation.</p>}
          {checkout&&!terminal&&['created','authenticated'].includes(current.status)&&<a className="text-primary underline" href={checkout} target="_blank" rel="noopener noreferrer">Continue secure Razorpay checkout</a>}
          {!terminal&&<Button variant="outline" disabled={role!=="owner"||Boolean(current.pendingOperation)||cancel.isPending}
            onClick={()=>{if(window.confirm("Cancel this subscription? Paid access will end when Razorpay confirms cancellation."))cancel.mutate()}}>Cancel subscription</Button>}
        </>:<p>{subscription.isError?'Subscription unavailable.':'Free tier. No paid subscription is active.'}</p>}
        {cancel.isError&&<p role="alert" className="text-destructive">{cancel.error.message}</p>}
        <Button onClick={()=>navigate('/app/billing/plans')}>View plans</Button>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Verified-run credits</CardTitle></CardHeader><CardContent className="space-y-3">
        {credits.isLoading?<p>Loading credits...</p>:credits.isError?<p role="alert" className="text-destructive">{credits.error.message}</p>:credits.data&&<>
          <p>Available: {credits.data.available}</p><p>Reserved by running workflows: {credits.data.reserved}</p><p>Total balance: {credits.data.balance}</p>
        </>}
        <p className="text-sm text-muted-foreground">Credits are consumed only after a completed run passes verification. Failed and incomplete runs consume no credits.</p>
      </CardContent></Card>
    </div>
    <CreditPurchaseCard plan={plan} subscription={current}/>
  </div>
}
