import { useParams, useNavigate } from "react-router-dom"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "@/api/client"
import { isLiveApi } from "@/api/http"
import { queryKeys } from "@/api/query-keys"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { formatCompactNumber, formatListingPrice } from "@/lib/formatters"
import { Download, Star, ArrowLeft, CheckCircle2, Loader2, Store } from "lucide-react"

export function ListingDetailPage() {
  const { listingId } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data: listing, isLoading, error: listingError } = useQuery({
    queryKey: queryKeys.marketplace.detail(listingId!),
    queryFn: () => api.marketplace.listings.get(listingId!),
    enabled: !!listingId
  })

  const { data: reviews, error: reviewsError } = useQuery({
    queryKey: queryKeys.marketplace.reviews(listingId!),
    queryFn: () => api.marketplace.reviews.list(listingId!),
    enabled: !!listingId
  })

  const installMutation = useMutation({
    mutationFn: () => api.marketplace.install(listingId!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.marketplace.myAssets })
      alert(isLiveApi ? "Installed successfully." : "Installed successfully (Mock)")
      navigate("/app/marketplace/my-assets")
    }
  })

  if (isLoading) return <div className="animate-pulse">Loading listing...</div>
  if (listingError || !listing) return <div role="alert" className="text-destructive">Could not load this listing: {listingError?.message ?? "Listing unavailable"}</div>
  if (listing.pricing.type !== "free") return <div role="alert">This listing is unavailable. Marketplace listings are free-only in v1.</div>

  return (
    <div className="space-y-8 max-w-4xl">
      <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="-ml-3 text-muted-foreground">
        <ArrowLeft className="mr-2 h-4 w-4" /> Back
      </Button>

      <div className="flex flex-col md:flex-row gap-8 items-start">
        <div className="flex-1 space-y-6">
          <div>
            <div className="flex items-center gap-3 mb-4">
              <Badge variant="secondary" className="capitalize">{listing.assetType.replace("_", " ")}</Badge>
              {listing.category && <Badge variant="outline" className="capitalize">{listing.category}</Badge>}
            </div>
            <h1 className="text-3xl font-bold">{listing.title}</h1>
            {listing.shortDescription && <p className="text-lg text-muted-foreground mt-2">{listing.shortDescription}</p>}
          </div>

            <div className="flex items-center gap-6 text-sm">
            {listing.seller.displayName && <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                <Store className="h-4 w-4 text-primary" />
              </div>
              <div>
                <div className="font-medium">{listing.seller.displayName}</div>
                <div className="text-muted-foreground text-xs">Seller</div>
              </div>
            </div>}
            {listing.rating !== undefined && <div className="flex flex-col">
              <span className="flex items-center gap-1 font-medium">
                <Star className="h-4 w-4 fill-primary text-primary" />
                {listing.rating}
              </span>
              {listing.reviewCount !== undefined && <span className="text-muted-foreground text-xs">{listing.reviewCount} reviews</span>}
            </div>}
            {listing.installCount !== undefined && <div className="flex flex-col">
              <span className="font-medium">{formatCompactNumber(listing.installCount)}</span>
              <span className="text-muted-foreground text-xs">Installs</span>
            </div>}
          </div>

          <div className="prose dark:prose-invert max-w-none pt-4 border-t border-border">
            <h3>Overview</h3>
            <p>{listing.description || "No description has been provided."}</p>
          </div>

          <div className="pt-4 border-t border-border">
            <h3 className="font-semibold mb-4">{isLiveApi ? "Your review" : "Reviews"}</h3>
            {reviewsError && <p role="alert" className="text-destructive text-sm">Could not load reviews: {reviewsError.message}</p>}
            <div className="space-y-4">
              {reviews?.length === 0 ? <div className="text-muted-foreground text-sm">{isLiveApi ? "You have not reviewed this listing." : "No reviews yet."}</div> : (
                reviews?.map(r => (
                  <div key={r.id} className="p-4 rounded-lg bg-surface-hover">
                    <div className="flex items-center justify-between mb-2">
                      {r.author.name && <div className="font-medium text-sm">{r.author.name}</div>}
                      <div className="flex items-center gap-1 text-xs">
                        <Star className="h-3 w-3 fill-primary text-primary" />
                        {r.rating}
                      </div>
                    </div>
                    {r.title && <h4 className="font-semibold text-sm">{r.title}</h4>}
                    {r.body && <p className="text-sm text-muted-foreground mt-1">{r.body}</p>}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="w-full md:w-80 shrink-0 sticky top-24">
          <div className="rounded-xl border border-border bg-surface p-6 shadow-sm">
            <div className="text-3xl font-bold mb-6">
              {formatListingPrice(listing.pricing)}
            </div>
            <Button 
              className="w-full mb-4" 
              size="lg" 
              disabled={installMutation.isPending}
              onClick={() => installMutation.mutate()}
            >
              {installMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Download className="h-4 w-4 mr-2" />}
              Install Now
            </Button>
            
            {installMutation.error && <p role="alert" className="text-sm text-destructive mb-4">{installMutation.error.message}</p>}
            {!isLiveApi && <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2 text-muted-foreground">
                <CheckCircle2 className="h-4 w-4 text-primary" /> verified publisher
              </div>
              <div className="flex items-center gap-2 text-muted-foreground">
                <CheckCircle2 className="h-4 w-4 text-primary" /> instantly available
              </div>
            </div>}

            <div className="mt-6 pt-6 border-t border-border space-y-4">
              {listing.tags.length > 0 && <div>
                <div className="text-xs text-muted-foreground mb-1">Tags</div>
                <div className="flex flex-wrap gap-2">
                  {listing.tags.map(tag => (
                    <Badge key={tag} variant="outline" className="text-xs">{tag}</Badge>
                  ))}
                </div>
              </div>}
              <div>
                <div className="text-xs text-muted-foreground mb-1">Last updated</div>
                <div className="text-sm">{new Date(listing.updatedAt).toLocaleDateString()}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
