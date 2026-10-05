import {describe,expect,it} from "vitest";
import {marketplaceRisk,type MarketplaceRiskSignals} from "./risk";
const observed: MarketplaceRiskSignals = {scanner:{verdict:"clean",reportId:"scn_current"},firstListing:false,outsideActions:[],accountScopes:[],priorTakedowns:0};
describe("marketplace advisory risk",()=>{
  it("keeps observed zero distinct from missing evidence",()=>{
    expect(marketplaceRisk(observed)).toMatchObject({score:0,incomplete:false});
    const missing=marketplaceRisk({...observed,scanner:null,outsideActions:null,accountScopes:null});
    expect(missing).toMatchObject({score:0,incomplete:true});
    expect(missing.reasons.filter(reason=>!reason.observed).map(reason=>reason.signal)).toEqual(["scanner","outside_actions","account_scopes"]);
  });
  it("explains first-listing risk without inventing scan findings",()=>{
    const value=marketplaceRisk({...observed,firstListing:true});
    expect(value.score).toBe(15);expect(value.reasons.find(reason=>reason.signal==="first_listing")).toMatchObject({points:15});
    expect(value.reasons.find(reason=>reason.signal==="scanner")).toMatchObject({points:0,evidence:["scn_current"]});
  });
  it("uses the supplied current scan and marks unavailable scans incomplete",()=>{
    expect(marketplaceRisk({...observed,scanner:{verdict:"findings",reportId:"scn_latest"}}).score).toBe(20);
    expect(marketplaceRisk({...observed,scanner:{verdict:"blocked",reportId:"scn_latest"}}).score).toBe(35);
    expect(marketplaceRisk({...observed,scanner:{verdict:"unavailable",reportId:"scn_latest"}})).toMatchObject({score:0,incomplete:true});
  });
  it("deduplicates declared actions and scopes and bounds recorded takedowns",()=>{
    const value=marketplaceRisk({...observed,outsideActions:["email.send","email.send"],accountScopes:["mail.send"],priorTakedowns:3});
    expect(value.score).toBe(60);expect(value.reasons.find(reason=>reason.signal==="outside_actions")?.evidence).toEqual(["email.send"]);
    expect(value.reasons.find(reason=>reason.signal==="prior_takedowns")?.points).toBe(25);
  });
  it("caps all observed risk at 100 and returns no publication decision",()=>{
    const value=marketplaceRisk({...observed,scanner:{verdict:"blocked",reportId:"scn_latest"},firstListing:true,outsideActions:["email.send"],accountScopes:["mail.send"],priorTakedowns:50});
    expect(value.score).toBe(100);expect(Object.keys(value).sort()).toEqual(["incomplete","reasons","score"]);
  });
  it("refuses an invented fractional, negative or unbounded count",()=>{
    for(const priorTakedowns of [-1,0.5,Infinity,NaN])expect(()=>marketplaceRisk({...observed,priorTakedowns})).toThrow("Invalid recorded takedown count");
  });
});
