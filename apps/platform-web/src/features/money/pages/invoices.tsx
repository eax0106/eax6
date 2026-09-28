import { useQuery } from "@tanstack/react-query"
import { PageHeader } from "@/components/common/page-header"
import { Card, CardContent } from "@/components/ui/card"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import { formatProviderMoney } from "../provider-pricing"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { FileText } from "lucide-react"

export function InvoicesPage() {
  const { data: invoices, isLoading, isError } = useQuery({
    queryKey: queryKeys.billing.invoices,
    queryFn: () => api.billing.getInvoices()
  })

  return (
    <div className="space-y-8">
      <PageHeader 
        title="Recent Invoices"
        description="View the most recent invoices from the billing provider."
      />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice ID</TableHead>
                <TableHead>Issue Date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Invoice</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Loading invoices...</TableCell>
                </TableRow>
              ) : isError ? (
                <TableRow><TableCell colSpan={5} role="alert" className="text-center py-8 text-destructive">Could not load invoices.</TableCell></TableRow>
              ) : invoices?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No invoices found.</TableCell>
                </TableRow>
              ) : (
                invoices?.map((invoice) => (
                  <TableRow key={invoice.id}>
                    <TableCell className="font-medium flex items-center gap-2">
                      <FileText className="h-4 w-4 text-muted-foreground" />
                      {invoice.id}
                    </TableCell>
                    <TableCell>{new Date(invoice.issuedAt).toLocaleDateString()}</TableCell>
                    <TableCell>
                      <Badge variant={invoice.status === 'paid' ? 'success' : invoice.status === 'failed' ? 'danger' : 'default'} className="capitalize">
                        {invoice.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-medium">{formatProviderMoney(invoice.amount, invoice.currency)}</TableCell>
                    <TableCell className="text-right">
                      {invoice.documentUrl ? (
                        <a href={invoice.documentUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                          View / download
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
