import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CreateCreditPurchaseSchema, creditPurchaseAmounts } from "@alterx/contracts"
import type { BillingPlan, BillingSubscription } from "@/api/types"
import { api } from "@/api/client"
import { isLiveApi, mutationKey } from "@/api/http"
import { queryKeys } from "@/api/query-keys"
import { usePermissions } from "@/features/permissions/hooks/usePermissions"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { formatProviderMoney, hostedCheckoutUrl } from "../provider-pricing"

const historyKey = ["billing", "credit-purchases"] as const
const completed = new Set(["delivered", "cancelled", "expired"])
const labels = {
  submitting: "Checkout confirmation pending", checkout_ready: "Awaiting payment", payment_pending: "Payment confirmation pending",
  delivery_pending: "Payment confirmed; credit delivery pending", delivered: "Credits delivered", cancelled: "Checkout cancelled", expired: "Checkout expired",
}

export function CreditPurchaseCard({plan, subscription}: {plan: BillingPlan | undefined; subscription: BillingSubscription | null | undefined}) {
  const {role} = usePermissions(), client = useQueryClient()
  const [credits, setCredits] = useState("10"), [gstin, setGstin] = useState("")
  const attempt = useRef<{fingerprint: string; key: string; purchaseId?: string} | null>(null)
  const canRead = role === "owner" || role === "admin"
  const history = useQuery({queryKey: historyKey, queryFn: ()=>api.billing.getCreditPurchases(), enabled:canRead,
    refetchInterval: query=>query.state.data?.some(purchase=>!completed.has(purchase.state))?15_000:false})
  const pending = history.data?.find(purchase=>!completed.has(purchase.state))
  const selectedId = pending?.id ?? history.data?.[0]?.id
  const selected = useQuery({queryKey:[...historyKey,selectedId], queryFn:()=>api.billing.getCreditPurchase(selectedId!), enabled:canRead&&Boolean(selectedId),
    refetchInterval: query=>query.state.data && !completed.has(query.state.data.state)?15_000:false})
  const purchase = selected.data
  useEffect(()=>{
    if (purchase && completed.has(purchase.state) && attempt.current?.purchaseId === purchase.id) attempt.current = null
    if(purchase?.state === "delivered") void client.invalidateQueries({queryKey:queryKeys.billing.credits})
  },[purchase?.id,purchase?.state,client])
  function reload() {void client.invalidateQueries({queryKey:historyKey}); void client.invalidateQueries({queryKey:queryKeys.billing.credits})}
  const create = useMutation({mutationFn: async ()=> {
    const input = CreateCreditPurchaseSchema.parse({credits:Number(credits),plan_version:plan!.version,...(gstin.trim()?{gstin:gstin.trim().toUpperCase()}:{})})
    const fingerprint = JSON.stringify(input)
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = {fingerprint,key:mutationKey("credit-purchase")}
    return api.billing.createCreditPurchase(input,attempt.current.key)
  }, onSuccess: result=> {
    if (attempt.current) attempt.current.purchaseId = result.id
    if (completed.has(result.state)) attempt.current = null
    client.setQueryData([...historyKey,result.id],result);reload()
  }, onError:reload})
  const refresh = useMutation({mutationFn:()=>api.billing.refreshCreditPurchase(purchase!.id,purchase!.etag),
    onSuccess: result=>{client.setQueryData([...historyKey,result.id],result);reload()}, onError:reload})
  const configured = isLiveApi && plan && plan.id !== "free" && Boolean(plan.commercial?.extraCreditPriceMinor) && Boolean(plan.commercial?.creditsPerVerifiedRun) &&
    subscription && ["active","pending","halted","paused"].includes(subscription.status)
  let amounts: ReturnType<typeof creditPurchaseAmounts> | undefined
  if(configured) {try {amounts = creditPurchaseAmounts(Number(credits),plan.commercial!.extraCreditPriceMinor!)} catch { /* Invalid totals cannot start checkout. */ }}
  const validInput = amounts && CreateCreditPurchaseSchema.safeParse({credits:Number(credits),plan_version:plan?.version,...(gstin.trim()?{gstin:gstin.trim().toUpperCase()}:{})}).success
  const blocked = role !== "owner" || !validInput || history.isLoading || history.isError || Boolean(pending) || create.isPending
  const link = purchase && !completed.has(purchase.state) && ["checkout_ready","payment_pending"].includes(purchase.state) ? hostedCheckoutUrl(purchase.checkoutUrl ?? undefined) : undefined
  return <Card><CardHeader><CardTitle>Buy extra execution credits</CardTitle></CardHeader><CardContent className="space-y-4">
    {!configured?<p>{isLiveApi?"Extra-credit checkout is unavailable until your active paid plan has configured credit prices.":"Demo extra-credit checkout is unavailable. No paid price is configured."}</p>:<>
      <p>{formatProviderMoney(plan!.commercial!.extraCreditPriceMinor!,"INR")} per execution credit; {plan!.commercial!.creditsPerVerifiedRun} credits per verified run.</p>
      <label className="block">Execution credits<input aria-label="Execution credits" type="number" min="1" max="1000000" step="1" value={credits} onChange={event=>setCredits(event.target.value)} className="ml-3 rounded border px-2 py-1"/></label>
      <label className="block">GSTIN (optional)<input aria-label="Extra-credit GSTIN (optional)" value={gstin} onChange={event=>setGstin(event.target.value)} className="ml-3 rounded border px-2 py-1"/></label>
      {amounts?<p>Credits: {formatProviderMoney(amounts.basePriceMinor,"INR")} + GST (18%): {formatProviderMoney(amounts.gstMinor,"INR")} = {formatProviderMoney(amounts.totalMinor,"INR")} total. No gateway fee added.</p>:<p>Choose a whole number of credits with a checkout total between ₹1 and ₹10000000.</p>}
      <Button disabled={Boolean(blocked)} onClick={()=>create.mutate()}>{create.isPending?"Preparing checkout...":"Prepare extra-credit checkout"}</Button>
      {role!=="owner"&&<p>Only the tenant owner can buy or refresh extra credits.</p>}
    </>}
    <p className="text-sm text-muted-foreground">Complete payment on Razorpay. Returning from checkout does not confirm payment. Credits arrive after payment and delivery are confirmed; subscription access remains governed by its current status.</p>
    {create.isError&&<p role="alert" className="text-destructive">{create.error.message}</p>}
    {refresh.isError&&<p role="alert" className="text-destructive">{refresh.error.message}</p>}
    <Button variant="outline" onClick={reload} disabled={!canRead}>Reload extra-credit purchases</Button>
    {history.isLoading?<p>Loading extra-credit purchases...</p>:history.isError?<p role="alert">Extra-credit purchase history unavailable. Reload to try again.</p>:history.data?.length===0?<p>No extra-credit purchases yet.</p>:null}
    {selected.isError&&<p role="alert">Current purchase unavailable. Reload before taking another action.</p>}
    {purchase&&<div className="space-y-2">
      <p>{labels[purchase.state]}: {purchase.quote.credits} credits, {formatProviderMoney(purchase.quote.totalMinor,"INR")} including GST.</p>
      {link&&<a className="text-primary underline" href={link} target="_blank" rel="noopener noreferrer">Continue extra-credit Razorpay checkout</a>}
      {!completed.has(purchase.state)&&<Button variant="outline" disabled={role!=="owner"||refresh.isPending} onClick={()=>refresh.mutate()}>{refresh.isPending?"Checking payment...":"Check extra-credit payment"}</Button>}
    </div>}
    {history.data&&history.data.length>0&&<ul aria-label="Extra-credit purchase history" className="space-y-2">
      {history.data.map(item=><li key={item.id}>{item.quote.credits} credits · {formatProviderMoney(item.quote.totalMinor,"INR")} · {labels[item.state]}</li>)}
    </ul>}
  </CardContent></Card>
}
