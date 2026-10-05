import { describe,expect,it,vi } from "vitest";
import { EvalHistoryClient,historyConfig,historyQuerySchema } from "./history.client";
const row={id:"00000000-0000-4000-8000-000000000001",goldenSetName:"planner",goldenSetDomain:"planner",goldenSetVersion:1,subject:"engine",trigger:"manual",status:"completed",passRate:0.9,startedAt:null,completedAt:null,createdAt:"2026-10-05T00:00:00+00:00"};
const config={baseUrl:"http://history.test",tokenRef:"env:INTERNAL_SERVICE_TOKEN",timeoutMs:100};
describe("evaluation history client",()=>{
 it("encodes bounded query and service authorization and preserves scores and original versions",async()=>{
  const resolve=vi.fn(async()=>"history-test-token"),fetcher=vi.fn(async()=>Response.json({data:[row],nextCursor:"next"}));
  expect(await new EvalHistoryClient(config,resolve,fetcher).list({limit:25,golden_set:"planner test",cursor:"opaque"},"trace")).toEqual({data:[row],nextCursor:"next"});
  const [url,init]=fetcher.mock.calls[0]! as unknown as [string,RequestInit];expect(new URL(url).searchParams.get("golden_set")).toBe("planner test");expect(init.headers).toMatchObject({Authorization:"Bearer history-test-token",traceparent:"trace"});expect(resolve).toHaveBeenCalledWith(config.tokenRef);
 });
 it.each([{}, {data:[{...row,passRate:1.1}],nextCursor:null},{data:[{...row,id:"invented"}],nextCursor:null}])("rejects malformed upstream history %j",async body=>{
  await expect(new EvalHistoryClient(config,async()=>"token",async()=>Response.json(body)).list({limit:25})).rejects.toMatchObject({problem:{status:502}});
 });
 it.each([[503,503],[401,502],[400,400],[500,502]])("maps upstream %i to %i without body details",async(status,expected)=>{
  await expect(new EvalHistoryClient(config,async()=>"token",async()=>Response.json({detail:"private upstream details"},{status})).list({limit:25})).rejects.toMatchObject({problem:{status:expected}});
 });
 it("fails before network when credential cannot resolve and bounds request timeouts",async()=>{
  const fetcher=vi.fn();await expect(new EvalHistoryClient(config,async()=>{throw new Error("private secret details");},fetcher).list({limit:25})).rejects.toMatchObject({problem:{status:502}});expect(fetcher).not.toHaveBeenCalled();
  const slow:typeof fetch=async(_url,init)=>new Promise((_accept,reject)=>init?.signal?.addEventListener("abort",()=>reject(Object.assign(new Error("Timeout"),{name:"AbortError"}))));
  await expect(new EvalHistoryClient({...config,timeoutMs:10},async()=>"token",slow).list({limit:25})).rejects.toMatchObject({problem:{status:504}});
 });
 it("validates request bounds and derives the listener port from actual environment",()=>{
  expect(historyQuerySchema.parse({})).toEqual({limit:25});for(const value of [{limit:0},{limit:101},{limit:"bad"},{golden_set:""},{cursor:"a".repeat(257)},{other:1}])expect(historyQuerySchema.safeParse(value).success).toBe(false);
  expect(historyConfig({EVAL_SERVICE_PORT:"9123"}).baseUrl).toBe("http://127.0.0.1:9123");
  for(const url of ["file:///private","http://user:secret@host","https://host#fragment","https://host?query"])expect(()=>historyConfig({EVAL_HISTORY_BASE_URL:url})).toThrow();
 });
});
