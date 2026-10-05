import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import { PageHeader } from "@/components/common/page-header"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export function SellerDashboardPage() {
  const listings=useQuery({queryKey:queryKeys.seller.listings,queryFn:()=>api.seller.listings.list()})
  return <div className="space-y-8">
    <PageHeader title="Seller Dashboard" description="Share free marketplace listings. Every published listing goes through review."/>
    {listings.isError&&<p role="alert" className="text-destructive">{listings.error.message}</p>}
    <Card><CardHeader><CardTitle>Your listings</CardTitle></CardHeader><CardContent className="space-y-4">
      {listings.isLoading?<p>Loading listings...</p>:listings.data&&<p>{listings.data.length} listings; {listings.data.filter(listing=>listing.status==='published').length} published.</p>}
      <Link className="text-primary underline" to="/app/seller/listings">Manage listings</Link>
    </CardContent></Card>
  </div>
}
