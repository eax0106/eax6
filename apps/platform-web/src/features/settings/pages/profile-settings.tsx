import * as React from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Loader2, Upload } from "lucide-react"
import { api } from "@/api/client"
import { isLiveApi } from "@/api/http"
import { queryKeys } from "@/api/query-keys"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { toast } from "sonner"

export function ProfileSettings() {
  const queryClient = useQueryClient()
  
  const { data: profile, isLoading } = useQuery({
    queryKey: queryKeys.settings.profile,
    queryFn: () => api.getProfile(),
  })
  
  const [name, setName] = React.useState("")
  const [email, setEmail] = React.useState("")
  const [jobTitle, setJobTitle] = React.useState("")
  
  React.useEffect(() => {
    if (profile) {
      setName(profile.name)
      setEmail(profile.email)
      setJobTitle(profile.jobTitle || "")
    }
  }, [profile])

  const { mutate, isPending } = useMutation({
    mutationFn: (data: { name: string; jobTitle: string }) => api.updateProfile(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.profile })
      toast.success("Profile updated successfully")
    },
    onError: () => {
      toast.error("Failed to update profile")
    }
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    mutate({ name, jobTitle })
  }

  if (isLoading || !profile) {
    return <div className="h-64 flex items-center justify-center border rounded-xl border-border"><Loader2 className="animate-spin text-text-muted" /></div>
  }

  const isDirty = name !== profile.name || jobTitle !== (profile.jobTitle || "")

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-text-primary">Profile</h1>
        <p className="text-text-secondary mt-2">Manage your personal information and preferences.</p>
      </div>

      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        <div className="px-6 py-5 border-b border-border">
          <h3 className="text-lg font-medium text-text-primary">Personal Information</h3>
        </div>
        
        <form onSubmit={handleSubmit} className="px-6 py-6 space-y-8">
          <div className="flex items-center gap-6">
            <Avatar className="h-20 w-20">
              <AvatarImage src={profile.avatarUrl} />
              <AvatarFallback className="bg-primary/10 text-primary text-xl">
                {profile.name.substring(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="space-y-2">
              <div className="flex gap-2">
                <Button variant="outline" size="sm" type="button" className="gap-2">
                  <Upload className="h-4 w-4" />
                  Change photo
                </Button>
                <Button variant="ghost" size="sm" type="button" className="text-danger hover:bg-danger/10 hover:text-danger">
                  Remove
                </Button>
              </div>
              <p className="text-xs text-text-muted">JPG, GIF or PNG. 1MB max.</p>
            </div>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-text-primary">Full name</label>
              <Input 
                value={name} 
                onChange={(e) => setName(e.target.value)} 
                required
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-text-primary">Email address</label>
              <Input 
                value={email} 
                readOnly
                disabled
                className="bg-surface-raised cursor-not-allowed text-text-muted"
              />
              <p className="text-xs text-text-muted mt-1">Email cannot be changed.</p>
            </div>
            {/* No job title is stored in live mode; it is not offered there. */}
            {!isLiveApi && (
              <div className="space-y-2">
                <label className="text-sm font-medium text-text-primary">Job title</label>
                <Input 
                  value={jobTitle} 
                  onChange={(e) => setJobTitle(e.target.value)} 
                  placeholder="e.g. Product Manager"
                />
              </div>
            )}
          </div>
          <div className="flex justify-end pt-4">
            <Button type="submit" disabled={!isDirty || isPending}>
              {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save changes
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
