import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { createSystemCallerContext, isSystemCallerContext } from "./system-caller";

const srcRoot = join(__dirname, "..");

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** Files that import the system caller, by relative import path. */
export function importsSystemJobs(source: string): boolean {
  return /from\s+["'][^"']*system-jobs\/[^"']*["']/.test(source);
}

describe("system caller (D1)", () => {
  it("recognises only contexts it made", () => {
    const made = createSystemCallerContext({ tenantId: "t", traceparent: "x" });
    expect(isSystemCallerContext(made)).toBe(true);
    expect(isSystemCallerContext({ ...made })).toBe(false);
  });

  it("carries the system principal, an empty workspace and no permissions of its own", () => {
    const made = createSystemCallerContext({ tenantId: "t", traceparent: "x" });
    expect(made).toMatchObject({ userId: "system:platform-jobs", workspaceId: "", permissions: [] });
    expect(Object.isFrozen(made)).toBe(true);
  });

  it("the import check sees an import and ignores an unrelated one", () => {
    expect(importsSystemJobs('import { createSystemCallerContext } from "../system-jobs/system-caller";')).toBe(true);
    expect(importsSystemJobs('import { x } from "../engine/auth";')).toBe(false);
  });

  it("no controller can reach the system caller (it is for background jobs only)", () => {
    const offenders = filesUnder(srcRoot)
      .filter((file) => file.endsWith(".controller.ts"))
      .filter((file) => importsSystemJobs(readFileSync(file, "utf8")))
      .map((file) => relative(srcRoot, file));
    expect(offenders).toEqual([]);
  });

  it("only producers, runners and the engine auth provider import it", () => {
    const allowed = (path: string) =>
      /\.(producer|runner)\.ts$/.test(path) || path === "engine/auth.ts" || path.startsWith("system-jobs/");
    const offenders = filesUnder(srcRoot)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".spec.ts"))
      .filter((file) => importsSystemJobs(readFileSync(file, "utf8")))
      .map((file) => relative(srcRoot, file))
      .filter((path) => !allowed(path));
    expect(offenders).toEqual([]);
  });

  it("a controller may reach a runner only if it is one of the trigger controllers", () => {
    const triggerControllers = ["notifications/engine-events/engine-event-scheduler.controller.ts"];
    const importsRunner = (source: string) => /from\s+["'][^"']*\.(runner|producer)["']/.test(source);
    expect(importsRunner('import { X } from "./engine-event-notification.runner";')).toBe(true);
    expect(importsRunner('import { X } from "./notification.service";')).toBe(false);
    const offenders = filesUnder(srcRoot)
      .filter((file) => file.endsWith(".controller.ts"))
      .filter((file) => importsRunner(readFileSync(file, "utf8")))
      .map((file) => relative(srcRoot, file))
      .filter((path) => !triggerControllers.includes(path));
    expect(offenders).toEqual([]);
  });
});
