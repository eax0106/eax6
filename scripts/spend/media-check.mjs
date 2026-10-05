// D30 (B3.6): one real call each to image generation, speech synthesis and
// transcription through the shipped AWS adapters. Prints the call count and an
// upper-bound cost first; spends only with --apply and only within USD 1.
//
//   MEDIA_BUCKET_NAME=<bucket> node scripts/spend/media-check.mjs [--apply]
//
// The transcription call transcribes the synthesized speech, so one run proves
// both audio paths end to end. Every object the run writes is deleted after
// its bytes are checked. Exit 1 when any call failed; the JSON report names it.
import {
  PollyTtsProvider,
  S3ObjectStorageProvider,
  TitanImageProvider,
  TranscribeSttProvider,
} from "@alterx/adapters";
import {
  assertWithinCeiling,
  estimateMediaCheckUsd,
  isPng,
  isWav,
  transcriptContains,
} from "./spend-guard.mjs";

const apply = process.argv.includes("--apply");
const region = process.env.AWS_REGION ?? "ap-south-1";
const bucketName = process.env.MEDIA_BUCKET_NAME;
if (!bucketName) throw new Error("MEDIA_BUCKET_NAME is required");

const tenantId = "ten_018f4d6e-2b4a-7a3e-8c1a-0000000000d3";
const speechText = "Alter media check. The quick brown fox jumps over the lazy dog.";
const expectedWords = ["media", "check", "quick", "brown", "fox"];
const imageSide = 512;

const estimateUsd = estimateMediaCheckUsd({
  images: 1,
  speechChars: speechText.length,
  transcribeSeconds: 60,
});
const plan = { calls: 3, region, bucketName, estimateUsd: Number(estimateUsd.toFixed(4)), apply };
console.log(JSON.stringify({ plan }));
assertWithinCeiling(estimateUsd);
if (!apply) process.exit(0);

const storage = new S3ObjectStorageProvider({ region });
const written = [];
const report = {};

async function attempt(name, run) {
  const startedAt = Date.now();
  try {
    report[name] = { status: "ok", ...(await run()), ms: Date.now() - startedAt };
  } catch (error) {
    report[name] = {
      status: "failed",
      error: `${error.constructor.name}: ${error.message}`,
      ms: Date.now() - startedAt,
    };
  }
}

await attempt("image", async () => {
  const image = await new TitanImageProvider({ region, bucketName }, storage).generateImage({
    tenantId,
    prompt: "A small red paper boat on calm blue water, flat illustration",
    options: { width: imageSide, height: imageSide },
  });
  written.push(image.reference);
  const bytes = await storage.getObject(image.reference);
  if (!isPng(bytes)) throw new Error("stored image is not a PNG");
  return { servedBy: image.servedBy, width: image.width, height: image.height, bytes: bytes.length };
});

let speechReference;
await attempt("speech", async () => {
  const speech = await new PollyTtsProvider({ region, bucketName }, storage).synthesizeSpeech({
    tenantId,
    text: speechText,
    voiceConfig: { voiceId: "Joanna", engine: "standard" },
  });
  written.push(speech.reference);
  const bytes = await storage.getObject(speech.reference);
  if (!isWav(bytes)) throw new Error("stored speech is not a WAV file");
  if (speech.durationMs <= 0) throw new Error("speech duration is not positive");
  speechReference = speech.reference;
  return { durationMs: speech.durationMs, bytes: bytes.length, chars: speechText.length };
});

await attempt("transcription", async () => {
  if (speechReference === undefined) throw new Error("no synthesized speech to transcribe");
  const result = await new TranscribeSttProvider({ region, bucketName }, storage).transcribe({
    tenantId,
    audioRef: speechReference,
  });
  if (!transcriptContains(result.transcript, expectedWords)) {
    throw new Error(`transcript does not contain the spoken words: ${result.transcript}`);
  }
  return { transcript: result.transcript, confidence: result.confidence };
});

for (const reference of written) {
  await storage.deleteObject(reference);
  if (await storage.objectExists(reference)) throw new Error(`cleanup left ${reference}`);
}
report.cleanup = { deleted: written.length };

console.log(JSON.stringify({ report }));
process.exitCode = Object.values(report).some((entry) => entry.status === "failed") ? 1 : 0;
