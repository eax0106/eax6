import assert from "node:assert/strict";
import { assertWithinCeiling } from "./spend-guard.mjs";

assertWithinCeiling(0.037);
assert.throws(() => assertWithinCeiling(1.2), /exceeds the USD 1 ceiling; not running/);
assert.throws(() => assertWithinCeiling(0.5, 2), /exceeds the approved USD 1/);
assert.throws(() => assertWithinCeiling(Number.NaN), /not a valid amount/);
assert.throws(() => assertWithinCeiling(-1), /not a valid amount/);

console.log("spend-guard spec: all assertions passed");
