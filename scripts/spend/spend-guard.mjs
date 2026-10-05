// D30 spend guard shared by the one-off real-AWS runs. Every run prints its
// call count and an upper-bound cost estimate first, and refuses to spend
// when that estimate exceeds the approved ceiling (USD 1 per run).

export const MAX_RUN_USD = 1;

// Public on-demand list prices, upper bounds (checked 2026-10-05).
export const PRICES_USD = {
  // Titan Image Generator v2, one premium 1024x1024 image.
  titanImage: 0.012,
  // Polly neural voice, per character (standard is a quarter of this).
  pollyPerChar: 16 / 1_000_000,
  // Transcribe batch, per started minute (AWS bills at least 15 seconds).
  transcribePerMinute: 0.024,
};

export function estimateMediaCheckUsd({ images, speechChars, transcribeSeconds }) {
  const minutes = Math.max(1, Math.ceil(transcribeSeconds / 60));
  return (
    images * PRICES_USD.titanImage +
    speechChars * PRICES_USD.pollyPerChar +
    minutes * PRICES_USD.transcribePerMinute
  );
}

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

export function isPng(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes.length > signature.length && signature.every((value, index) => bytes[index] === value);
}

export function isWav(bytes) {
  return (
    bytes.length > 44 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WAVE"
  );
}

// True when every expected word appears in the transcript, ignoring case and
// punctuation. Speech recognition may add or drop filler, never the anchors.
export function transcriptContains(transcript, expectedWords) {
  const words = new Set(transcript.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/));
  return expectedWords.every((word) => words.has(word.toLowerCase()));
}
