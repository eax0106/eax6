#!/usr/bin/env node
/*
 * Proves that the pull request for a branch is reviewing the commit that is
 * checked out here, and that CI passed for that exact commit.
 *
 * Written because a report in this repository once said "CI green" for PR #191
 * when the green run belonged to a different commit: the shared checkout had
 * been switched to main mid-task, so the branch head never moved. `gh pr checks`
 * answers for whatever the PR head happens to be, which is why that read as a
 * pass. Both gates below name the commit explicitly instead.
 *
 * Usage:
 *   node scripts/verify-pr-head.mjs head <branch>   # PR head === local branch tip
 *   node scripts/verify-pr-head.mjs ci   <branch>   # CI success for that commit
 */
import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim();
    console.error(`${command} ${args.join(" ")} failed: ${detail}`);
    process.exit(1);
  }
  return (result.stdout ?? "").trim();
}

const [mode, branch] = process.argv.slice(2);
if (!["head", "ci"].includes(mode ?? "") || !branch) {
  console.error("usage: verify-pr-head.mjs <head|ci> <branch>");
  process.exit(2);
}

const localHead = run("git", ["rev-parse", branch]);
const prJson = run("gh", ["pr", "view", branch, "--json", "number,headRefOid,state"]);
const pr = JSON.parse(prJson);

if (pr.state !== "OPEN") {
  console.error(`PR #${pr.number} is ${pr.state}, not OPEN`);
  process.exit(1);
}
if (pr.headRefOid !== localHead) {
  console.error(
    `PR #${pr.number} head ${pr.headRefOid.slice(0, 7)} is not local ${branch} ${localHead.slice(0, 7)}`,
  );
  process.exit(1);
}

if (mode === "head") {
  console.log(`pr-head-matches ${localHead.slice(0, 7)}`);
  process.exit(0);
}

const runsJson = run("gh", [
  "run",
  "list",
  "--branch",
  branch,
  "--limit",
  "20",
  "--json",
  "databaseId,headSha,status,conclusion",
]);
const runs = JSON.parse(runsJson).filter((entry) => entry.headSha === localHead);
if (runs.length === 0) {
  console.error(`no CI run recorded for ${localHead.slice(0, 7)}`);
  process.exit(1);
}
const unfinished = runs.filter((entry) => entry.status !== "completed");
if (unfinished.length > 0) {
  console.error(`CI still running for ${localHead.slice(0, 7)}: run ${unfinished[0].databaseId}`);
  process.exit(1);
}
const failed = runs.filter((entry) => entry.conclusion !== "success");
if (failed.length > 0) {
  console.error(
    `CI ${failed[0].conclusion} for ${localHead.slice(0, 7)}: run ${failed[0].databaseId}`,
  );
  process.exit(1);
}
console.log(`ci-success-for-head ${localHead.slice(0, 7)} runs=${runs.length}`);
