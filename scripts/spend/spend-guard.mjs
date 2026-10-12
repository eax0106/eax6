// D30 spend guard shared by the one-off real-AWS runs. Every run prints its
// call count and an upper-bound cost estimate first, and refuses to spend
// when that estimate exceeds the approved ceiling (USD 1 per run).

export const MAX_RUN_USD = 1;

export function assertWithinCeiling(estimateUsd, ceilingUsd = MAX_RUN_USD) {
  if (!Number.isFinite(estimateUsd) || estimateUsd < 0) {
    throw new Error(`spend estimate is not a valid amount: ${estimateUsd}`);
  }
  if (ceilingUsd > MAX_RUN_USD) {
    throw new Error(`ceiling USD ${ceilingUsd} exceeds the approved USD ${MAX_RUN_USD}`);
  }
  if (estimateUsd > ceilingUsd) {
    throw new Error(
      `estimated USD ${estimateUsd.toFixed(4)} exceeds the USD ${ceilingUsd} ceiling; not running`,
    );
  }
}
