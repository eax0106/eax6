import {afterEach,beforeEach,describe,expect,it,vi} from "vitest"
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react"
import {QueryClient,QueryClientProvider} from "@tanstack/react-query"
vi.mock("@/api/http",async original=>({...await original<typeof import("@/api/http")>(),isLiveApi:true}))
import {BenchmarkHistoryPage} from "./benchmark-history"
const fetcher=vi.fn<typeof fetch>()
const row={id:"run_history",goldenSetName:"planner-native",goldenSetDomain:"planner",goldenSetVersion:3,subject:"engine",trigger:"manual",status:"completed",passRate:0.9,startedAt:null,completedAt:"2026-10-05T00:01:00Z",createdAt:"2026-10-05T00:00:00Z"}
beforeEach(()=>{fetcher.mockReset();vi.stubGlobal("fetch",fetcher)})
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
function view(){render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><BenchmarkHistoryPage/></QueryClientProvider>)}
describe("staff golden-set history live UI",()=>{
 it("shows loading then recorded versions and scores, preserving zero and unscored results",async()=>{
  let resolve!:(response:Response)=>void;fetcher.mockImplementationOnce(()=>new Promise(accept=>{resolve=accept}));view();expect(screen.getByRole("status").textContent).toContain("Loading evaluation history")
  resolve(Response.json({data:[row,{...row,id:"zero",passRate:0},{...row,id:"pending",status:"running",passRate:null}],nextCursor:null}));
  await screen.findByText("90.0%");expect(screen.getByText("0.0%")).toBeTruthy();expect(screen.getByText("Not scored")).toBeTruthy();expect(screen.getAllByText("3")).toHaveLength(3);expect(screen.queryByText("No evaluation runs found.")).toBeNull()
 })
 it("loads the next bounded server page and filters by an exact golden set name",async()=>{
  fetcher.mockImplementation(async url=>{const params=new URL(String(url),"http://app.test").searchParams;return Response.json(params.has("golden_set")?{data:[],nextCursor:null}:params.has("cursor")?{data:[{...row,id:"second",goldenSetName:"verification-native"}],nextCursor:null}:{data:[row],nextCursor:"history-cursor"})});view();await screen.findByText(row.goldenSetName)
  fireEvent.click(screen.getByRole("button",{name:"Load more"}));await screen.findByText("verification-native");expect(screen.getByText(row.goldenSetName)).toBeTruthy();expect(new URL(String(fetcher.mock.calls[1]![0]),"http://app.test").searchParams.get("cursor")).toBe("history-cursor");expect(screen.queryByRole("button",{name:"Load more"})).toBeNull()
  fireEvent.change(screen.getByRole("textbox",{name:"Golden set name"}),{target:{value:"  planner exact  "}});fireEvent.click(screen.getByRole("button",{name:"Filter"}));await screen.findByText("No evaluation runs found.");await waitFor(()=>expect(new URL(String(fetcher.mock.calls.at(-1)![0]),"http://app.test").searchParams.get("golden_set")).toBe("planner exact"))
 })
 it("shows service failure and permits recovery without inventing historical scores",async()=>{
  fetcher.mockImplementation(async()=>Response.json({detail:"Evaluation history busy"},{status:503}));view();expect((await screen.findByRole("alert")).textContent).toContain("Evaluation history busy");expect(screen.queryByText("No evaluation runs found.")).toBeNull()
  fetcher.mockImplementation(async()=>Response.json({data:[row],nextCursor:null}));fireEvent.click(screen.getByRole("button",{name:"Refresh"}));await screen.findByText(row.goldenSetName);expect(screen.queryByRole("alert")).toBeNull()
 })
 it("renders a truthful empty history",async()=>{fetcher.mockImplementation(async()=>Response.json({data:[],nextCursor:null}));view();await screen.findByText("No evaluation runs found.");expect(screen.queryByText(/%$/)).toBeNull()})
})
