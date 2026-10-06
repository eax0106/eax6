import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Source inventory, not a rendered-screen test. No media UI exists today;
// introducing one must first revisit the owner's unavailable-action policy.
const unavailableAction = /\/media\/(?:image|stt)\b|generateImage|transcribeAudio|generate\s+image|image\s+generation|transcri(?:be|ption)|speech.?to.?text/i;
function assertNoUnavailableAction(source: string, path: string) {
  if (unavailableAction.test(source)) throw new Error(`Unavailable MVP media action in ${path}`);
}
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.tsx?$/.test(entry.name) && !/\.(?:spec|test)\./.test(entry.name) ? [path] : [];
  });
}
describe("MVP media web source policy", () => {
  it("offers no unavailable image or transcription action in web source", () => {
    const files = sources(join(import.meta.dirname, ".."));
    expect(files.length).toBeGreaterThan(0);
    for (const path of files) assertNoUnavailableAction(readFileSync(path, "utf8"), path);
  });
  it("rejects known endpoint and visible-action controls while allowing speech", () => {
    for (const source of ["fetch('/api/v1/media/image')", "fetch('/api/v1/media/stt')", "<button>Generate image</button>", "<button>Transcribe audio</button>"]) {
      expect(() => assertNoUnavailableAction(source, "positive-control.tsx")).toThrow("Unavailable MVP media action");
    }
    expect(() => assertNoUnavailableAction("fetch('/api/v1/media/tts')", "speech.ts")).not.toThrow();
  });
});
