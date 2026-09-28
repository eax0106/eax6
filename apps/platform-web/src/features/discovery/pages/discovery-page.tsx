import { useQuery } from "@tanstack/react-query"
import { PageHeader } from "@/components/common/page-header"
import { Button } from "@/components/ui/button"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import { LoadingState } from "@/components/feedback/loading-state"
import type { UseCase } from "@/api/types"
import { Sparkles, ArrowRight, Zap, Target, BookOpen } from "lucide-react"
import { useNavigate } from "react-router-dom"
import { cn } from "@/lib/utils"
import { isLiveApi } from "@/api/http"
import { WorkspaceSuggestions } from "../components/workspace-suggestions"

export function DiscoveryPage() {
  const navigate = useNavigate()

  const { data: recommendations = [], isLoading: isLoadingRecs } = useQuery({
    queryKey: queryKeys.discovery.recommendations,
    queryFn: () => api.discovery.getRecommendations(),
  })

  const { data: allUseCases = [], isLoading: isLoadingAll } = useQuery({
    queryKey: queryKeys.discovery.useCases,
    queryFn: () => api.discovery.listUseCases(),
  })

  const handleStart = (useCase: UseCase) => {
    if (useCase.workflowTemplateId || useCase.projectTemplateId) {
      // Navigate to marketplace or template instantiation
      navigate(`/app/marketplace/listings/${useCase.workflowTemplateId || useCase.projectTemplateId}`)
    } else if (useCase.starterPrompt) {
      // Start a conversation with the prompt
      navigate(`/app/home?prompt=${encodeURIComponent(useCase.starterPrompt)}`)
    } else {
      navigate("/app/home")
    }
  }

  const renderUseCaseCard = (useCase: UseCase) => (
    <div key={useCase.id} className="flex flex-col rounded-xl border border-border bg-surface p-5 hover:border-border-strong transition-colors h-full">
      <div className="flex items-center gap-2 mb-3">
        <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary">
          {useCase.category}
        </span>
        <span className={cn(
          "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border",
          useCase.difficulty === "starter" ? "border-success/50 text-success" : 
          useCase.difficulty === "intermediate" ? "border-warning/50 text-warning" : 
          "border-danger/50 text-danger"
        )}>
          {useCase.difficulty === "starter" ? "Starter" : useCase.difficulty === "intermediate" ? "Intermediate" : "Advanced"}
        </span>
      </div>
      
      <h3 className="font-semibold text-text-primary mb-2">{useCase.title}</h3>
      <p className="text-sm text-text-secondary flex-1 mb-4">{useCase.description}</p>
      
      <div className="flex flex-col gap-2 mt-auto text-xs text-text-muted mb-4 border-t border-border/50 pt-3">
        {useCase.outcome && useCase.outcome.length > 0 && (
          <div className="flex items-center gap-2">
            <Target className="h-3.5 w-3.5" />
            <span>{useCase.outcome[0]}</span>
          </div>
        )}
        {useCase.estimatedSetupMinutes && (
          <div className="flex items-center gap-2">
            <Zap className="h-3.5 w-3.5" />
            <span>~{useCase.estimatedSetupMinutes} mins to set up</span>
          </div>
        )}
        {useCase.audience && useCase.audience.length > 0 && (
          <div className="flex items-center gap-2">
            <BookOpen className="h-3.5 w-3.5" />
            <span>For: {useCase.audience.join(", ")}</span>
          </div>
        )}
      </div>

      <Button className="w-full" onClick={() => handleStart(useCase)}>
        {useCase.workflowTemplateId || useCase.projectTemplateId ? "Use Template" : "Start with AlterX"}
        <ArrowRight className="ml-2 h-4 w-4" />
      </Button>
    </div>
  )

  if (isLoadingRecs || isLoadingAll) {
    return (
      <div className="space-y-6">
        <PageHeader title="Discover" description="Discover what you can build with AlterX" />
        <LoadingState fullScreen />
      </div>
    )
  }

  // Group all use cases by category (excluding recommended ones if we want, but let's just show them all in popular)
  const categories = Array.from(new Set(allUseCases.map(uc => uc.category)))

  return (
    <div className="space-y-10 pb-10 max-w-6xl">
      <PageHeader 
        title="Discover" 
        description="Discover what you can build with AlterX. Explore use-cases and templates to accelerate your workflows."
      />

      {isLiveApi && <WorkspaceSuggestions />}

      {recommendations.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold flex items-center gap-2 mb-4">
            <Sparkles className="h-5 w-5 text-primary" />
            Recommended for you
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {recommendations.map(renderUseCaseCard)}
          </div>
        </section>
      )}

      {categories.map(category => {
        const categoryUseCases = allUseCases.filter(uc => uc.category === category)
        if (categoryUseCases.length === 0) return null
        
        return (
          <section key={category}>
            <h2 className="text-lg font-semibold mb-4 border-b border-border pb-2">{category}</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {categoryUseCases.map(renderUseCaseCard)}
            </div>
          </section>
        )
      })}
    </div>
  )
}
