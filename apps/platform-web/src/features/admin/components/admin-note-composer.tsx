import {useState} from "react"
import {useMutation} from "@tanstack/react-query"
import {Button} from "@/components/ui/button"

export function AdminNoteComposer({append}: {append: (body: string) => Promise<unknown>}) {
  const [body, setBody] = useState("")
  const note = useMutation({
    mutationFn: () => append(body.trim()),
    onSuccess: () => setBody(""),
  })
  return <form className="space-y-2" onSubmit={event => {
    event.preventDefault()
    if (body.trim() && !note.isPending) note.mutate()
  }}>
    <label htmlFor="admin-note" className="text-sm font-medium">New administrative note</label>
    <textarea id="admin-note" value={body} onChange={event => {setBody(event.target.value); note.reset()}}
      maxLength={4000} required disabled={note.isPending} rows={3}
      className="block w-full rounded-md border bg-background p-3" />
    <p className="text-sm text-muted-foreground">Saved notes cannot be edited. Add a new note to correct an earlier one.</p>
    {note.error && <p role="alert" className="text-destructive">{note.error instanceof Error ? note.error.message : "Note could not be saved"}</p>}
    {note.isSuccess && <p role="status">Note added.</p>}
    <Button type="submit" disabled={!body.trim() || note.isPending}>{note.isPending ? "Adding…" : "Add note"}</Button>
  </form>
}
