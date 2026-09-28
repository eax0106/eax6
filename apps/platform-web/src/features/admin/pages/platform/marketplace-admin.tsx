import * as React from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "@/api/client"
import { isLiveApi } from "@/api/http"
import type { MarketplaceReviewItem, SellerVerification } from "@/api/services/marketplace-admin"
import { queryKeys } from "@/api/query-keys"
import { PageHeader } from "@/components/common/page-header"
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Loader2, Check, X, AlertTriangle } from "lucide-react"

export function MarketplaceAdmin() {
  const queryClient = useQueryClient()
  
  const { data: reviews, isLoading } = useQuery({
    queryKey: queryKeys.admin.marketplace.reviewQueue,
    queryFn: () => api.admin.marketplace.reviewQueue()
  })

  const reviewMutation = useMutation({
    mutationFn: ({ item, action }: { item: MarketplaceReviewItem, action: "approve" | "reject" | "changes_requested" | "suspend" }) => api.admin.marketplace.reviewListing(item.id, action, undefined, item.resourceType),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.admin.marketplace.reviewQueue })
  })

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-6">
      <PageHeader 
        title="Marketplace Moderation"
        description="Review submitted assets, agents, and workflows for public listing."
      />

      <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
        <Table>
          <TableHeader className="bg-slate-950/50">
            <TableRow className="border-slate-800">
              <TableHead className="text-slate-400">Listing</TableHead>
              <TableHead className="text-slate-400">Seller</TableHead>
              <TableHead className="text-slate-400">Type</TableHead>
              <TableHead className="text-slate-400">{isLiveApi ? "Trust" : "Risk Score"}</TableHead>
              <TableHead className="text-slate-400">Status</TableHead>
              <TableHead className="text-slate-400 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-slate-500">
                  <Loader2 className="w-5 h-5 animate-spin mx-auto" />
                </TableCell>
              </TableRow>
            ) : reviews?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-slate-500">
                  No pending reviews.
                </TableCell>
              </TableRow>
            ) : (
              reviews?.map((r) => (
                <TableRow key={r.id} className="border-slate-800">
                  <TableCell>
                    <div className="font-medium text-slate-200">{r.listingName}</div>
                    <div className="text-xs text-slate-500">{new Date(r.submittedAt).toLocaleDateString()}</div>
                  </TableCell>
                  <TableCell>
                    <span className="text-slate-300">{r.sellerName}</span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="bg-slate-800 text-slate-300 border-slate-700 capitalize">
                      {r.assetType}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {!r.risk ? (
                      <span className="text-sm text-slate-400">{r.trustLevel?.replaceAll("_", " ") ?? "—"}</span>
                    ) : (
                    <Badge variant="outline" className={
                      r.risk === "high" ? "bg-red-500/10 text-red-400 border-red-500/20" :
                      r.risk === "medium" ? "bg-amber-500/10 text-amber-400 border-amber-500/20" :
                      "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                    }>
                      {r.risk.toUpperCase()}
                    </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={
                      r.status === "approved" ? "text-emerald-400 border-emerald-400/20" :
                      r.status === "rejected" || r.status === "suspended" ? "text-red-400 border-red-400/20" :
                      r.status === "changes_requested" ? "text-amber-400 border-amber-400/20" :
                      "text-primary border-primary"
                    }>
                      {r.status.replace("_", " ")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      {r.status === "pending_review" && (
                        <>
                          <Button variant="ghost" size="sm" onClick={() => reviewMutation.mutate({ item: r, action: "approve" })} className="text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10">
                            <Check className="w-4 h-4 mr-2" /> Approve
                          </Button>
                          {!isLiveApi && (
                          <Button variant="ghost" size="sm" onClick={() => reviewMutation.mutate({ item: r, action: "changes_requested" })} className="text-amber-400 hover:text-amber-300 hover:bg-amber-500/10">
                            <AlertTriangle className="w-4 h-4 mr-2" /> Needs Changes
                          </Button>
                          )}
                          <Button variant="ghost" size="sm" onClick={() => reviewMutation.mutate({ item: r, action: "reject" })} className="text-red-400 hover:text-red-300 hover:bg-red-500/10">
                            <X className="w-4 h-4 mr-2" /> Reject
                          </Button>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <SellerVerificationQueue />
    </div>
  )
}

/** Seller identity documents awaiting staff review (task B2.4). Rejection needs a reason. */
function SellerVerificationQueue() {
  const queryClient = useQueryClient()
  const [reasons, setReasons] = React.useState<Record<string, string>>({})
  const { data: verifications, isLoading, isError, error } = useQuery({
    queryKey: queryKeys.admin.marketplace.verifications,
    queryFn: () => api.admin.marketplace.verificationQueue(),
  })
  const review = useMutation({
    mutationFn: ({ item, decision }: { item: SellerVerification; decision: "approved" | "rejected" }) =>
      api.admin.marketplace.reviewVerification(item, decision, decision === "rejected" ? reasons[item.id]?.trim() : undefined),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.admin.marketplace.verifications }),
  })

  return (
    <section className="space-y-3" aria-labelledby="seller-verification-heading">
      <h2 id="seller-verification-heading" className="text-lg font-semibold text-slate-200">Seller verification</h2>
      {isError && <p role="alert" className="text-sm text-red-400">{(error as Error).message}</p>}
      {review.isError && <p role="alert" className="text-sm text-red-400">{(review.error as Error).message}</p>}
      <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
        <Table>
          <TableHeader className="bg-slate-950/50">
            <TableRow className="border-slate-800">
              <TableHead className="text-slate-400">Tenant</TableHead>
              <TableHead className="text-slate-400">Documents</TableHead>
              <TableHead className="text-slate-400">Submitted</TableHead>
              <TableHead className="text-slate-400 text-right">Decision</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={4} className="h-16 text-center text-slate-500"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></TableCell></TableRow>
            ) : !verifications?.length ? (
              <TableRow><TableCell colSpan={4} className="h-16 text-center text-slate-500">No verifications awaiting review.</TableCell></TableRow>
            ) : (
              verifications.map((v) => (
                <TableRow key={v.id} className="border-slate-800">
                  <TableCell className="font-mono text-xs text-slate-300">{v.tenantId}</TableCell>
                  <TableCell>
                    <ul className="text-xs text-slate-400 space-y-1">
                      {v.documents.map((d) => <li key={d.type}><span className="text-slate-300">{d.type.replaceAll("_", " ")}</span> · <span className="font-mono">{d.objectRef}</span></li>)}
                    </ul>
                  </TableCell>
                  <TableCell className="text-sm text-slate-400">{new Date(v.submittedAt).toLocaleString()}</TableCell>
                  <TableCell>
                    <div className="flex justify-end items-center gap-2">
                      <Input
                        aria-label={`Rejection reason for ${v.id}`}
                        placeholder="Reason (to reject)"
                        className="h-8 w-44"
                        value={reasons[v.id] ?? ""}
                        onChange={(e) => setReasons((current) => ({ ...current, [v.id]: e.target.value }))}
                      />
                      <Button variant="ghost" size="sm" disabled={review.isPending} onClick={() => review.mutate({ item: v, decision: "approved" })} className="text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10">
                        <Check className="w-4 h-4 mr-2" /> Approve
                      </Button>
                      <Button variant="ghost" size="sm" disabled={review.isPending || !reasons[v.id]?.trim()} onClick={() => review.mutate({ item: v, decision: "rejected" })} className="text-red-400 hover:text-red-300 hover:bg-red-500/10">
                        <X className="w-4 h-4 mr-2" /> Reject
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}
