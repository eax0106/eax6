import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";

const options = JSON.parse(readFileSync("apps/orchestration-service/project.json", "utf8")).targets.test.options;
const commands = options.commands ?? [options.command];
const tests = commands.filter(command => typeof command === "string" && command.startsWith("vitest run "));
assert.equal(tests.length, 1, "The engine task must contain one Vitest run command");
const listing = tests[0].replace(/^vitest run /, "node node_modules/vitest/vitest.mjs list ") + " --filesOnly --json";
const discovered = JSON.parse(execFileSync(listing, { shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }))
  .map(entry => relative(process.cwd(), entry.file).split(sep).join("/"));
const tracked = execFileSync("git", ["ls-files", "apps/orchestration-service/src"], { encoding: "utf8" })
  .trim().split("\n").filter(file => file.endsWith(".spec.ts"));
assert.ok(tracked.length > 0, "No tracked engine specs found");
assert.deepEqual([...new Set(discovered)].sort(), tracked.sort(), "The configured engine task omits or adds spec files");
console.log(`engine-test-discovery-passed; tracked=${tracked.length}; discovered=${discovered.length}`);
