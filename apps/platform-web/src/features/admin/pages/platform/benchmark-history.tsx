import {useState} from "react"
import {useInfiniteQuery} from "@tanstack/react-query"
import {benchmarkHistoryService} from "@/api/services/benchmark-history"
import {Button} from "@/components/ui/button"
import {Input} from "@/components/ui/input"
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from "@/components/ui/table"

export function BenchmarkHistoryPage(){
 const [draft,setDraft]=useState(""),[goldenSet,setGoldenSet]=useState("")
 const history=useInfiniteQuery({queryKey:["admin","evaluation-history",goldenSet],initialPageParam:undefined as string|undefined,
  queryFn:({pageParam})=>benchmarkHistoryService.list({cursor:pageParam,goldenSet:goldenSet||undefined}),getNextPageParam:last=>last.nextCursor??undefined})
 const rows=history.data?.pages.flatMap(page=>page.data)??[]
 return <div className="p-6 space-y-6">
  <div><h1 className="text-2xl font-semibold">Golden-set history</h1><p className="text-muted-foreground">Recorded evaluation runs. Scores refer to the golden-set version used.</p></div>
  <form className="flex gap-2 max-w-xl" onSubmit={event=>{event.preventDefault();setGoldenSet(draft.trim())}}>
   <Input aria-label="Golden set name" placeholder="Filter by exact golden set name" maxLength={128} value={draft} onChange={event=>setDraft(event.target.value)}/><Button type="submit">Filter</Button><Button type="button" variant="outline" onClick={()=>void history.refetch()} disabled={history.isFetching}>Refresh</Button>
  </form>
  {history.isLoading&&<p role="status">Loading evaluation history…</p>}
  {history.error&&<div role="alert" className="text-destructive">{history.error instanceof Error?history.error.message:"Evaluation history is unavailable"}</div>}
  {!history.isLoading&&!history.error&&rows.length===0&&<p>No evaluation runs found.</p>}
  {rows.length>0&&<Table><TableHeader><TableRow><TableHead>Golden set</TableHead><TableHead>Version</TableHead><TableHead>Subject</TableHead><TableHead>Status</TableHead><TableHead>Pass rate</TableHead><TableHead>Recorded</TableHead><TableHead>Completed</TableHead></TableRow></TableHeader><TableBody>
   {rows.map(run=><TableRow key={run.id}><TableCell><span className="font-medium">{run.goldenSetName}</span><div className="text-xs text-muted-foreground">{run.goldenSetDomain} · {run.trigger}</div></TableCell><TableCell>{run.goldenSetVersion}</TableCell><TableCell>{run.subject}</TableCell><TableCell>{run.status}</TableCell><TableCell>{run.passRate===null?"Not scored":`${(run.passRate*100).toFixed(1)}%`}</TableCell><TableCell><time dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleString()}</time></TableCell><TableCell>{run.completedAt?<time dateTime={run.completedAt}>{new Date(run.completedAt).toLocaleString()}</time>:"—"}</TableCell></TableRow>)}
  </TableBody></Table>}
  {history.hasNextPage&&<Button variant="outline" onClick={()=>void history.fetchNextPage()} disabled={history.isFetchingNextPage}>{history.isFetchingNextPage?"Loading more…":"Load more"}</Button>}
 </div>
}
