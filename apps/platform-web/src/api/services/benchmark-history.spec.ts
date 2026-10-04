import {afterEach,beforeEach,describe,expect,it,vi} from "vitest"
const mode=vi.hoisted(()=>({live:true}))
vi.mock("../http",async original=>({...await original<typeof import("../http")>(),get isLiveApi(){return mode.live}}))
import {benchmarkHistoryService} from "./benchmark-history"
const fetcher=vi.fn<typeof fetch>()
beforeEach(()=>{mode.live=true;fetcher.mockReset();vi.stubGlobal("fetch",fetcher)})
afterEach(()=>vi.unstubAllGlobals())
describe("staff history adapter",()=>{
 it("passes only bounded pagination and filter fields through live authenticated HTTP",async()=>{
  fetcher.mockImplementation(async()=>Response.json({data:[],nextCursor:null}));await expect(benchmarkHistoryService.list({limit:10,cursor:"opaque & cursor",goldenSet:"planner / v2"})).resolves.toEqual({data:[],nextCursor:null})
  const [url,init]=fetcher.mock.calls[0]!;const parsed=new URL(String(url),"http://app.test");expect(parsed.pathname).toBe("/api/v1/admin/benchmarks/runs");expect(Object.fromEntries(parsed.searchParams)).toEqual({limit:"10",cursor:"opaque & cursor",golden_set:"planner / v2"});expect(init?.credentials).toBe("include")
 })
 it("shows empty demo history without manufactured evaluation metrics",async()=>{mode.live=false;await expect(benchmarkHistoryService.list()).resolves.toEqual({data:[],nextCursor:null});expect(fetcher).not.toHaveBeenCalled()})
})
