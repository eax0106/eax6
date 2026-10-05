import * as React from "react"
import {useMutation,useQuery,useQueryClient} from "@tanstack/react-query"
import {api} from "@/api/client"
import type {MarketplaceListing} from "@/api/types"
import {queryKeys} from "@/api/query-keys"
import {Button} from "@/components/ui/button"
import {Input} from "@/components/ui/input"

export function ListingReview({listing,onClose}:{listing:MarketplaceListing;onClose:()=>void}){
  const client=useQueryClient(),key=[...queryKeys.seller.listings,"review",listing.id]
  const review=useQuery({queryKey:key,queryFn:()=>api.seller.listings.review(listing.id)})
  const [title,setTitle]=React.useState(listing.title),[description,setDescription]=React.useState(listing.description),[reason,setReason]=React.useState("")
  React.useEffect(()=>{if(review.data){setTitle(review.data.name);setDescription(review.data.description??listing.description)}},[review.data,listing.description])
  const save=useMutation({mutationFn:()=>api.seller.listings.update(listing.id,{title,description,reason,etag:review.data?.etag}),
    onSuccess:async value=>{client.setQueryData(key,value);await client.invalidateQueries({queryKey:queryKeys.seller.listings})}})
  const resubmit=useMutation({mutationFn:()=>api.seller.listings.resubmit(listing.id,reason,review.data?.etag),
    onSuccess:async value=>{client.setQueryData(key,value);await client.invalidateQueries({queryKey:queryKeys.seller.listings})}})
  const pending=save.isPending||resubmit.isPending,canEdit=review.data?.status==="needs_changes"
  const validReason=reason.trim().length>0&&reason.trim().length<=1000
  const dirty=!!review.data&&(title!==review.data.name||description!==(review.data.description??listing.description))
  return <section aria-label={`Review ${listing.title}`} className="border rounded-lg p-4 space-y-4">
    <h2 className="text-lg font-semibold">Review and corrections</h2>
    {review.isLoading&&<p role="status">Loading review…</p>}
    {review.isError&&<p role="alert">{(review.error as Error).message}</p>}
    {save.isError&&<p role="alert">{(save.error as Error).message}</p>}
    {resubmit.isError&&<p role="alert">{(resubmit.error as Error).message}</p>}
    {review.data&&<>
      <p>Status: {review.data.status.replaceAll("_"," ")}</p>
      <ul className="space-y-2">{review.data.review_notes?.map(note=><li key={note.id} className="text-sm">
        <span className="text-muted-foreground">{note.actor_ref} · {note.action.replaceAll("_"," ")} · {new Date(note.occurred_at).toLocaleString()}</span>
        <p className="whitespace-pre-wrap">{note.reason}</p>
      </li>)}</ul>
      {!review.data.review_notes?.length&&<p>No reviewer notes.</p>}
      {canEdit&&<div className="space-y-3">
        <label className="block">Listing name<Input aria-label="Listing name" value={title} maxLength={255} disabled={pending} onChange={event=>setTitle(event.target.value)}/></label>
        <label className="block">Description<textarea aria-label="Listing description" className="block w-full rounded border bg-transparent p-2" value={description} maxLength={2000} disabled={pending} onChange={event=>setDescription(event.target.value)}/></label>
        <label className="block">Correction reason<textarea aria-label="Correction reason" className="block w-full rounded border bg-transparent p-2" value={reason} maxLength={1000} disabled={pending} onChange={event=>setReason(event.target.value)}/></label>
        <div className="flex gap-2">
          <Button variant="outline" disabled={pending||!dirty||!title.trim()||!validReason||!review.data.etag} onClick={()=>save.mutate()}>Save corrections</Button>
          <Button disabled={pending||dirty||!validReason||!review.data.etag} onClick={()=>resubmit.mutate()}>Resubmit for review</Button>
        </div>
        <p className="text-sm text-muted-foreground">Save your changes, then resubmit with a reason. Staff review determines publication.</p>
      </div>}
    </>}
    <div className="flex gap-2"><Button variant="outline" disabled={pending||review.isFetching} onClick={()=>void review.refetch()}>Reload review</Button><Button variant="ghost" disabled={pending} onClick={onClose}>Close review</Button></div>
  </section>
}
