import * as React from "react"
import { ListingReview } from "./listing-review"
import type { MarketplaceListing } from "@/api/types"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { api } from "@/api/client"
import { isLiveApi } from "@/api/http"
import { queryKeys } from "@/api/query-keys"
import { PageHeader } from "@/components/common/page-header"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatCompactNumber } from "@/lib/formatters"
import { Plus } from "lucide-react"

export function SellerListingsPage() {
  const navigate = useNavigate()
  const [selected,setSelected] = React.useState<MarketplaceListing | null>(null)
  
  const { data: listings, isLoading, error } = useQuery({
    queryKey: queryKeys.seller.listings,
    queryFn: () => api.seller.listings.list()
  })

  return (
    <div className="space-y-8">
      <PageHeader 
        title="Listings"
        description="Manage your published and drafted assets."
        primaryAction={
          <Button onClick={() => navigate("/app/seller/listings/new")}>
            <Plus className="mr-2 h-4 w-4" /> New Listing
          </Button>
        }
      />
      {isLiveApi && listings && listings.length >= 200 && <p className="text-sm text-muted-foreground">Showing the first 200 recent listings.</p>}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Listing</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Price</TableHead>
                {!isLiveApi && <TableHead className="text-right">Installs</TableHead>}
                <TableHead className="text-right">Updated</TableHead>
                <TableHead className="text-right">Review</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={isLiveApi ? 6 : 7} className="text-center py-8 text-muted-foreground animate-pulse">Loading listings...</TableCell>
                </TableRow>
              ) : error ? (
                <TableRow><TableCell colSpan={isLiveApi ? 6 : 7} role="alert" className="text-center py-8 text-destructive">Could not load listings: {error.message}</TableCell></TableRow>
              ) : listings?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={isLiveApi ? 6 : 7} className="text-center py-12 text-muted-foreground">
                    <p>No listings found.</p>
                  </TableCell>
                </TableRow>
              ) : (
                listings?.map((listing) => (
                  <TableRow key={listing.id}>
                    <TableCell className="font-medium max-w-[200px] truncate" title={listing.title}>
                      {listing.title}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="capitalize">{listing.assetType.replace("_", " ")}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={listing.status === "published" ? "success" : ["review", "submitted", "automated_review", "human_review", "needs_changes"].includes(listing.status) ? "warning" : "default"}>
                        {listing.status.replaceAll("_", " ")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {listing.pricing.type === "free" ? "Free" : "Unavailable in v1"}
                    </TableCell>
                    {!isLiveApi && <TableCell className="text-right">{formatCompactNumber(listing.installCount || 0)}</TableCell>}
                    <TableCell className="text-right text-muted-foreground text-sm">{new Date(listing.updatedAt).toLocaleDateString()}</TableCell>
                    <TableCell><Button variant="outline" size="sm" onClick={() => setSelected(listing)}>View review</Button></TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {selected && <ListingReview key={selected.id} listing={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}
