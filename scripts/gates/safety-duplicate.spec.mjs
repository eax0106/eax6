import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { run } from "./safety-duplicate.mjs";
import { GATES } from "./run-all.mjs";

const directory = `scripts/gates/probes/${randomUUID()}`;
await mkdir(directory, { recursive: true });
try {
  const transport = `${directory}/transport.ts`;
  await writeFile(transport, `import { request } from 'node:https';
import { PromptInjectionClassifier } from '@alterx/auth';
export const client = request;
export const classifier = PromptInjectionClassifier;
export const fetchDocument = (url: string) => fetch(url);
export type SsrfGuardPolicy = { allowedSchemes: readonly string[] };
`);
  assert.ok(!(await run()).some(finding => finding.file.startsWith(directory)), "Ordinary transport and consumers are allowed");
  const declaration = `${directory}/declaration.py`;
  await writeFile(declaration, "from typing import Protocol\nclass Classifier(Protocol):\n    def classify_prompt_injection(self, text: str) -> bool: ...\n");
  assert.ok(!(await run()).some(finding => finding.file === declaration), "Protocol declarations are allowed");
  const shortPython = `${directory}/short.py`;
  await writeFile(shortPython, "def screen_injection(text):\n    return 'override' in text\n");
  assert.ok((await run()).some(finding => finding.file === shortPython), "Short named Python implementations must be found");
  await rm(shortPython);
  for (const [kind, path, before, after] of [
    ["SSRF", "packages/adapters/src/http/ssrf-guard.ts", "isBlockedIpv6", "copyIpv6"],
    ["classifier", "packages/auth/session-gateway/src/prompt-injection-classifier.ts", "PromptInjectionClassifier", "CopiedClassifier"],
    ["redactor", "packages/adapters/src/presidio/presidio-pii-redaction-provider.ts", "PresidioPIIRedactionProvider", "CopiedRedactor"],
  ]) {
    const source = await readFile(path, "utf8");
    const copy = `${directory}/${kind}.ts`;
    await writeFile(copy, source.replaceAll(before, after));
    assert.ok((await run()).some(finding => finding.file === copy), `${kind}: renamed implementation copy must be found`);
    await rm(copy);
  }
  const named = `${directory}/named.ts`;
  await writeFile(named, "export function screenInjection(text: string) { return /override/.test(text); }");
  assert.ok((await run()).some(finding => finding.file === named), "Additional named implementation must be found");
  await rm(named);
  const python = `${directory}/classifier.py`;
  const mirror = await readFile("apps/verification-service/src/verification/model_gateway_client.py", "utf8");
  await writeFile(python, mirror.replaceAll("classify_prompt_injection", "copied_screen"));
  assert.ok((await run()).some(finding => finding.file === python), "Renamed Python implementation copy must be found");
  await rm(python);
  assert.ok(GATES.some(gate => gate.name === "safety-duplicate" && gate.run === run), "CI architecture runner must invoke the actual gate");
  assert.ok((await readFile(resolve(".github/workflows/ci.yml"), "utf8")).includes("node scripts/gates/safety-duplicate.spec.mjs"), "CI must run the regression probes");
  console.log("safety-duplicate-probes-passed");
} finally {
  await rm(directory, { recursive: true, force: true });
}
