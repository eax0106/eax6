import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate, useSearchParams } from "react-router-dom"
import { api } from "@/api/client"
import { isLiveApi } from "@/api/http"
import { queryKeys } from "@/api/query-keys"
import { PageHeader } from "@/components/common/page-header"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Loader2 } from "lucide-react"

export function NewListingPage() {
  const [searchParams] = useSearchParams()
  const workflowId = searchParams.get("workflowId")
  
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  
  const [title, setTitle] = useState("")
  const [shortDescription, setShortDescription] = useState("")
  const [description, setDescription] = useState("")
  const [category, setCategory] = useState("Productivity")
  
  const mutation = useMutation({
    mutationFn: () => api.seller.listings.create({
      title, shortDescription, description, category,
      assetType: workflowId ? "workflow_template" : "project_template",
      pricing: { type: "free" },
      tags: ["template"],
      licenseType: "single_workspace",
    }),
    onSuccess: (newListing) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.seller.listings })
      if (isLiveApi) {
        alert("Free draft created. Add a version before submitting for staff review. No identity documents are required.")
      } else {
        alert("Draft listing created! Submitting for review... (Mock)")
        void api.seller.listings.submit(newListing.id)
      }
      navigate("/app/seller/listings")
    }
  })

  return (
    <div className="space-y-8 max-w-2xl">
      <PageHeader 
        title="Create Listing"
        description={isLiveApi ? "Create a draft asset for the AlterX Marketplace." : "Publish a new asset to the AlterX Marketplace."}
      />

      <Card>
        <form onSubmit={(e) => { e.preventDefault(); mutation.mutate(); }}>
          <CardHeader>
            <CardTitle>Listing Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {workflowId && !isLiveApi && (
              <div className="bg-primary/10 text-primary px-3 py-2 rounded-md text-sm mb-4">
                Publishing workflow template for ID: {workflowId}
              </div>
            )}
            <div className="space-y-2">
              <Label>Title</Label>
              <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Acme Support Automation" required />
            </div>
            {!isLiveApi && <div className="space-y-2">
              <Label>Short Description</Label>
              <Input value={shortDescription} onChange={e => setShortDescription(e.target.value)} placeholder="A quick summary for the marketplace card." required />
            </div>}
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea 
                value={description} 
                onChange={e => setDescription(e.target.value)} 
                placeholder="Full details, requirements, and what is included." 
                rows={5}
                required 
              />
            </div>
            {!isLiveApi && <div className="space-y-2">
              <Label>Category</Label>
              <select 
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                value={category}
                onChange={e => setCategory(e.target.value)}
              >
                <option>Customer Support</option>
                <option>Finance</option>
                <option>Sales</option>
                <option>Research</option>
                <option>Productivity</option>
              </select>
            </div>}
            <p className="text-sm text-muted-foreground">V1 listings are free. Add a version and submit for staff review. No identity documents are required.</p>
            {mutation.error && <p role="alert" className="text-sm text-destructive">{mutation.error.message}</p>}
          </CardContent>
          <CardFooter className="flex justify-between">
            <Button type="button" variant="ghost" onClick={() => navigate(-1)}>Cancel</Button>
            <Button type="submit" disabled={mutation.isPending || !title}>
              {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isLiveApi ? "Save Draft" : "Save & Submit"}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  )
}
