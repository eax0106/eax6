import assert from "node:assert/strict";
import {
  assertWithinCeiling,
  estimateMediaCheckUsd,
  isPng,
  isWav,
  transcriptContains,
} from "./spend-guard.mjs";

const planned = estimateMediaCheckUsd({ images: 1, speechChars: 120, transcribeSeconds: 10 });
assert.ok(planned > 0.03 && planned < 0.04, `one image, 120 chars, one minute: ${planned}`);
assertWithinCeiling(planned);

assert.throws(
  () => assertWithinCeiling(estimateMediaCheckUsd({ images: 100, speechChars: 0, transcribeSeconds: 0 })),
  /exceeds the USD 1 ceiling; not running/,
);
assert.throws(() => assertWithinCeiling(0.5, 2), /exceeds the approved USD 1/);
assert.throws(() => assertWithinCeiling(Number.NaN), /not a valid amount/);
assert.throws(() => assertWithinCeiling(-1), /not a valid amount/);

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
assert.equal(isPng(png), true);
assert.equal(isPng(Buffer.from("not an image")), false);

const wav = Buffer.alloc(64);
wav.write("RIFF", 0, "ascii");
wav.write("WAVE", 8, "ascii");
assert.equal(isWav(wav), true);
assert.equal(isWav(Buffer.alloc(64)), false);

assert.equal(transcriptContains("Alter media check, one two three.", ["media", "check"]), true);
assert.equal(transcriptContains("Alter medical check.", ["media", "check"]), false);

console.log("spend-guard spec: all assertions passed");
