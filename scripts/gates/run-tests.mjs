#!/usr/bin/env node
// Runs vitest from the repository root on the spec files named as arguments and
// prints a success-only marker, so an acceptance gate can require both a zero
// exit and that marker. Node rather than a shell one-liner because gates run
// under cmd.exe on Windows and bash in CI.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
// --image sets the Postgres image for testcontainers specs, so one gate can
// prove a suite against the version CI pins and another against the version
// the deployment target runs. Passed as a flag rather than an environment
// prefix in the CHECK line, because gates run under cmd.exe on Windows where
// `VAR=value command` is not valid.
const imageIndex = argv.indexOf("--image");
const postgresImage = imageIndex === -1 ? undefined : argv[imageIndex + 1];
const specs = imageIndex === -1 ? argv : argv.filter((_, index) => index !== imageIndex && index !== imageIndex + 1);
if (specs.length === 0 || (imageIndex !== -1 && postgresImage === undefined)) {
  console.error("usage: run-tests.mjs [--image <tag>] <spec path> [<spec path> ...]");
  process.exit(2);
}

// A gate must fail when the spec it names does not exist: vitest treats an
// unmatched filter as "no tests" and exits zero, which would certify nothing.
const missing = specs.filter((spec) => !existsSync(resolve(repositoryRoot, spec)));
if (missing.length > 0) {
  console.error(`missing spec files: ${missing.join(", ")}`);
  process.exit(1);
}

// Resolve vitest's own entry and run it under this Node, rather than the
// node_modules/.bin shim: Node refuses to spawn .cmd/.bat without a shell
// (CVE-2024-27980), which on Windows makes a .bin shim fail with a null exit
// status and no output -- a gate failing for a reason that is not the code.
let vitestEntry;
try {
  const require = createRequire(resolve(repositoryRoot, "package.json"));
  const manifestPath = require.resolve("vitest/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const binary = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.vitest;
  if (binary === undefined) throw new Error("vitest package.json declares no bin");
  vitestEntry = resolve(dirname(manifestPath), binary);
} catch (error) {
  console.error(`cannot locate vitest (run pnpm install here first): ${error.message}`);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [vitestEntry, "run", "--reporter=dot", ...specs],
  {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env:
      postgresImage === undefined
        ? process.env
        : { ...process.env, POSTGRES_TEST_IMAGE: postgresImage },
  },
);
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
process.stdout.write(output);

if (result.error !== undefined) {
  console.error(`could not run vitest: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`vitest exited ${result.status}${result.signal ? ` on ${result.signal}` : ""}`);
  process.exit(result.status === null ? 1 : result.status);
}
// Vitest exits zero when a filter matches no test file, so require evidence
// that tests actually ran before printing the marker.
if (!/Tests\s+\d+\s+passed/.test(output)) {
  console.error("vitest reported no passing tests");
  process.exit(1);
}
console.log("gate-tests-ok");
