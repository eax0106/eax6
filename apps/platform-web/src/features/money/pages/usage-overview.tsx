import { useQuery } from "@tanstack/react-query"
import { PageHeader } from "@/components/common/page-header"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import { formatCurrency, formatCompactNumber, formatBytes } from "@/lib/formatters"
import { Activity, HardDrive, Cpu, Coins } from "lucide-react"
import { usePreferencesStore } from "@/features/settings/stores/usePreferencesStore"
import { type DisplayCurrency } from "@/api/types"
import { isLiveApi } from "@/api/http"
import { LiveUsageOverview } from "../components/live-usage"

export function UsageOverviewPage() {
  return isLiveApi ? <LiveUsageOverview /> : <DemoUsageOverview />
}

function DemoUsageOverview() {
  const { data: usage, isLoading } = useQuery({
    queryKey: queryKeys.usage.overview,
    queryFn: () => api.usage.getOverview()
  })

  const { currency, setCurrency } = usePreferencesStore()

  if (isLoading || !usage) {
    return <div className="p-8 text-muted-foreground animate-pulse">Loading usage...</div>
  }

  return (
    <div className="space-y-8">
      <PageHeader 
        title="Usage & Cost"
        description="Understand how AlterX resources are being used across your workspace."
        primaryAction={
          <div className="flex items-center gap-1 rounded-lg border border-ax-border bg-ax-surface-1 p-0.5">
            {(["USD", "INR"] as DisplayCurrency[]).map(c => (
              <button
                key={c}
                onClick={() => setCurrency(c)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all duration-300 ${
                  currency === c
                    ? "bg-primary text-black shadow-sm"
                    : "text-ax-text-muted hover:text-ax-text"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        }
      />

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Current Spend</CardTitle>
            <Coins className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{formatCurrency(usage.totalCost)}</div>
            <p className="text-xs text-muted-foreground mt-1">This billing period</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Workflow Runs</CardTitle>
            <Activity className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{formatCompactNumber(usage.runs)}</div>
            <p className="text-xs text-muted-foreground mt-1">Across {usage.workflowCount} workflows</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Tokens Processed</CardTitle>
            <Cpu className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{formatCompactNumber((usage.inputTokens || 0) + (usage.outputTokens || 0))}</div>
            <p className="text-xs text-muted-foreground mt-1">Input & Output</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Storage Used</CardTitle>
            <HardDrive className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{formatBytes(usage.storageBytes || 0)}</div>
            <p className="text-xs text-muted-foreground mt-1">Documents & Vector DB</p>
          </CardContent>
        </Card>
      </div>
      
      <Card>
        <CardHeader>
          <CardTitle>Usage Over Time</CardTitle>
          <CardDescription>Visualizing spend for the current billing period</CardDescription>
        </CardHeader>
        <CardContent>
          {/* Mock simple CSS bars for chart */}
          <div className="h-[200px] flex items-end gap-2 pb-4 pt-4 border-b">
            {Array.from({ length: 30 }).map((_, i) => (
              <div 
                key={i} 
                className="flex-1 bg-primary/20 hover:bg-primary/50 transition-colors rounded-t-sm"
                style={{ height: `${Math.max(10, Math.random() * 100)}%` }}
                title={`Day ${i+1}`}
              />
            ))}
          </div>
          <div className="flex justify-between mt-2 text-xs text-muted-foreground">
            <span>Aug 1</span>
            <span>Aug 15</span>
            <span>Aug 30</span>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
