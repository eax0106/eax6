export const RISK_WEIGHTS={blocked:35,findings:20,first:15,outside:20,scopes:15,takedown:10,maxTakedowns:25} as const;
export interface MarketplaceRiskSignals {
  scanner: {verdict: "clean" | "findings" | "blocked" | "errored" | "unavailable"; reportId: string} | null;
  firstListing: boolean | null;
  outsideActions: readonly string[] | null;
  accountScopes: readonly string[] | null;
  priorTakedowns: number | null;
}
export interface MarketplaceRiskReason {
  signal: "scanner" | "first_listing" | "outside_actions" | "account_scopes" | "prior_takedowns";
  points: number;
  detail: string;
  evidence: readonly string[];
  observed: boolean;
}

/** Advisory review ordering only. These weights never authorize publication. */
export function marketplaceRisk(signals: MarketplaceRiskSignals) {
  const reasons: MarketplaceRiskReason[] = [];
  if (signals.scanner) {
    const verdict = signals.scanner.verdict;
    reasons.push({signal: "scanner", points: verdict === "blocked" ? RISK_WEIGHTS.blocked : verdict === "findings" ? RISK_WEIGHTS.findings : 0,
      detail: `Latest scanner verdict: ${verdict}`, evidence: [signals.scanner.reportId],
      observed: verdict !== "errored" && verdict !== "unavailable"});
  } else reasons.push({signal: "scanner", points: 0, detail: "No recorded scanner verdict", evidence: [], observed: false});
  reasons.push({signal: "first_listing", points: signals.firstListing ? RISK_WEIGHTS.first : 0,
    detail: signals.firstListing === null ? "Seller history is not recorded" : signals.firstListing ? "Seller's first listing" : "Seller has earlier listings", evidence: [], observed: signals.firstListing !== null});
  for (const [signal, values, points, description] of [
    ["outside_actions", signals.outsideActions, RISK_WEIGHTS.outside, "Declared outside actions"],
    ["account_scopes", signals.accountScopes, RISK_WEIGHTS.scopes, "Declared account scopes"],
  ] as const) {
    const evidence = values === null ? [] : [...new Set(values)].sort();
    reasons.push({signal, points: evidence.length ? points : 0,
      detail: values === null ? `${description} are not recorded` : evidence.length ? `${description}: ${evidence.join(", ")}` : `No ${description.toLowerCase()}`,
      evidence, observed: values !== null});
  }
  if (signals.priorTakedowns !== null && (!Number.isSafeInteger(signals.priorTakedowns) || signals.priorTakedowns < 0)) throw new Error("Invalid recorded takedown count");
  reasons.push({signal: "prior_takedowns", points: signals.priorTakedowns === null ? 0 : Math.min(RISK_WEIGHTS.maxTakedowns, signals.priorTakedowns * RISK_WEIGHTS.takedown),
    detail: signals.priorTakedowns === null ? "Seller takedown history is not recorded" : `${signals.priorTakedowns} recorded prior takedown${signals.priorTakedowns === 1 ? "" : "s"}`,
    evidence: [], observed: signals.priorTakedowns !== null});
  return {score: Math.min(100, reasons.reduce((sum, reason) => sum + reason.points, 0)),
    incomplete: reasons.some(reason => !reason.observed), reasons};
}
