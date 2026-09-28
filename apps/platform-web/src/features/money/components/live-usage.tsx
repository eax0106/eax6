import { useQuery } from "@tanstack/react-query"
import { PageHeader } from "@/components/common/page-header"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { queryKeys } from "@/api/query-keys"
import { getMonthToDateUsage, type UsageCostLine } from "@/api/live-usage"
import { formatProviderMoney } from "../provider-pricing"
import { Activity, Coins } from "lucide-react"

// Live usage pages (task B2.9). The cost ledger records billable spend by
// source, provider and resource; it does not record tokens, runs per workflow
// or storage, so the demo's cards for those are not shown here.

function useMonthToDate() {
  return useQuery({ queryKey: queryKeys.usage.overview, queryFn: () => getMonthToDateUsage() })
}

function period(start: string, end: string) {
  return `${new Date(start).toLocaleDateString()} – ${new Date(end).toLocaleDateString()}`
}

export function LiveUsageOverview() {
  const usage = useMonthToDate()
  const bySource = new Map<string, { billableMinor: number; events: number }>()
  for (const line of usage.data?.lines ?? []) {
    const current = bySource.get(line.source) ?? { billableMinor: 0, events: 0 }
    bySource.set(line.source, { billableMinor: current.billableMinor + line.billableMinor, events: current.events + line.events })
  }

  return (
    <div className="space-y-8">
      <PageHeader title="Usage & Cost" description="Billable usage recorded for your workspace this month." />
      {usage.isLoading && <p className="text-muted-foreground animate-pulse">Loading usage...</p>}
      {usage.isError && <p role="alert" className="text-destructive">Could not load usage.</p>}
      {usage.data && (
        <>
          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Spend this month</CardTitle>
                <Coins className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{formatProviderMoney(usage.data.billableMinor, usage.data.currency)}</div>
                <p className="text-xs text-muted-foreground mt-1">{period(usage.data.periodStart, usage.data.periodEnd)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Billed operations</CardTitle>
                <Activity className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{usage.data.events.toLocaleString()}</div>
                <p className="text-xs text-muted-foreground mt-1">Model, tool, sandbox, browser and storage calls</p>
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>By source</CardTitle>
              <CardDescription>Where this month's spend came from</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Source</TableHead>
                    <TableHead className="text-right">Operations</TableHead>
                    <TableHead className="text-right">Spend</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bySource.size === 0 ? (
                    <TableRow><TableCell colSpan={3} className="text-center py-6 text-muted-foreground">No usage recorded this month.</TableCell></TableRow>
                  ) : (
                    [...bySource.entries()].sort((a, b) => b[1].billableMinor - a[1].billableMinor).map(([source, total]) => (
                      <TableRow key={source}>
                        <TableCell className="font-medium">{sourceName(source)}</TableCell>
                        <TableCell className="text-right">{total.events.toLocaleString()}</TableCell>
                        <TableCell className="text-right">{formatProviderMoney(total.billableMinor, usage.data!.currency)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

export function LiveCostBreakdown() {
  const usage = useMonthToDate()
  return (
    <div className="space-y-8">
      <PageHeader title="Cost Breakdown" description="This month's billable spend by provider and resource." />
      {usage.isLoading && <p className="text-muted-foreground animate-pulse">Loading costs...</p>}
      {usage.isError && <p role="alert" className="text-destructive">Could not load costs.</p>}
      {usage.data && (
        <Card>
          <CardContent className="pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Resource</TableHead>
                  <TableHead className="text-right">Operations</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usage.data.lines.length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="text-center py-6 text-muted-foreground">No usage recorded this month.</TableCell></TableRow>
                ) : (
                  usage.data.lines.map((line: UsageCostLine) => (
                    <TableRow key={`${line.source}/${line.provider}/${line.resource}`}>
                      <TableCell>{sourceName(line.source)}</TableCell>
                      <TableCell>{line.provider}</TableCell>
                      <TableCell className="font-mono text-xs">{line.resource}</TableCell>
                      <TableCell className="text-right">{line.events.toLocaleString()}</TableCell>
                      <TableCell className="text-right">{formatProviderMoney(line.billableMinor, usage.data!.currency)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

const sourceNames: Record<string, string> = {
  model_gateway: "Models",
  tool_gateway: "Tools",
  sandbox: "Sandbox",
  storage: "Storage",
  browser: "Browser",
}

function sourceName(source: string) {
  return sourceNames[source] ?? source
}
