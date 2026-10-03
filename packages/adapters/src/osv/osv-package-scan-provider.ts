import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { PackageScanProvider, PackageScanReport, PackageScanRequest, ScanFinding, ScanSeverity } from "@alterx/shared-clients";
import type { PackageArtifactReader } from "./package-artifact";
import { extractPackageLockfiles } from "./extract-lockfiles";

const execute = promisify(execFile);
const ScannerOutput = z.object({ results: z.array(z.object({
  source: z.object({ path: z.string().min(1) }),
  packages: z.array(z.object({
    package: z.object({ name: z.string().min(1), version: z.string().min(1), ecosystem: z.string().min(1) }),
    vulnerabilities: z.array(z.object({ id: z.string().min(1), summary: z.string().optional() })).optional(),
    groups: z.array(z.object({ ids: z.array(z.string().min(1)), max_severity: z.string().optional() })).optional(),
  })),
})) });

function severity(value: string | undefined): ScanSeverity {
  if (value === undefined || value === "UNKNOWN") return "info";
  if (!/^\d+(\.\d+)?$/.test(value) || Number(value) > 10) throw new Error("Invalid OSV severity");
  const score = Number(value);
  return score >= 9 ? "critical" : score >= 7 ? "high" : score >= 4 ? "medium" : score > 0 ? "low" : "info";
}

export function parseOsvScanOutput(raw: string, exit: number, root: string, ecosystem: PackageScanRequest["ecosystem"]): Pick<PackageScanReport, "verdict" | "findings"> {
  const report = ScannerOutput.parse(JSON.parse(raw));
  const findings: ScanFinding[] = [];
  let packages = 0;
  for (const source of report.results) {
    const path = relative(root, source.source.path);
    if (!path || path.startsWith("..") || path.startsWith("/")) throw new Error("Scanner reported an unexpected source path");
    for (const item of source.packages) {
      const allowed = ecosystem === "npm" ? ["npm"] : ecosystem === "pip" ? ["PyPI"] : ["npm", "PyPI"];
      if (!allowed.includes(item.package.ecosystem)) throw new Error("Package ecosystem does not match its manifest");
      packages += 1;
      for (const advisory of item.vulnerabilities ?? []) {
        const group = item.groups?.find(group => group.ids.includes(advisory.id));
        findings.push({ rule: advisory.id, severity: severity(group?.max_severity),
          locator: `${path}:${item.package.name}@${item.package.version}`,
          detail: `${advisory.summary ?? advisory.id}${group?.max_severity ? ` (CVSS ${group.max_severity})` : " (severity not supplied by OSV)"}` });
      }
    }
  }
  if (!packages || ![0, 1].includes(exit) || (exit === 1) !== (findings.length > 0)) throw new Error("Scanner did not produce a complete package result");
  return { verdict: findings.length ? "findings" : "clean", findings };
}

export class OsvPackageScanProvider implements PackageScanProvider {
  constructor(private readonly artifacts: PackageArtifactReader, private readonly executable = "osv-scanner") {}

  async scanPackage(request: PackageScanRequest): Promise<PackageScanReport> {
    const started = performance.now();
    const scannedAt = new Date().toISOString();
    let directory: string | undefined;
    let scannerVersion = "osv-scanner unavailable";
    try {
      const artifact = await this.artifacts.read(request);
      const files = extractPackageLockfiles(artifact.bytes, artifact.name);
      directory = await mkdtemp(join(tmpdir(), "alter-package-scan-"));
      const config = join(directory, "scanner-config.toml");
      await writeFile(config, "", { mode: 0o600 });
      const paths: string[] = [];
      for (const file of files) {
        const path = join(directory, file.path);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, file.bytes, { flag: "wx", mode: 0o600 });
        paths.push(path);
      }
      // No inherited service credentials or package-provided scanner configuration.
      const options = { cwd: directory, env: { PATH: process.env["PATH"], HOME: directory }, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" as const };
      const version = await execute(this.executable, ["--version"], options);
      const parsedVersion = /^osv-scanner version: (2\.\d+\.\d+)$/m.exec(version.stdout);
      if (!parsedVersion) throw new Error("OSV-Scanner v2 is required");
      scannerVersion = `osv-scanner ${parsedVersion[1]} sha256:${createHash("sha256").update(artifact.bytes).digest("hex")}`;
      const args = ["scan", "source", "--format=json", "--all-packages", "--all-vulns", "--no-resolve", "--no-call-analysis=go", "--no-call-analysis=rust", `--config=${config}`, ...paths.map(path => `--lockfile=${path}`)];
      let raw: string;
      let exit = 0;
      try { raw = (await execute(this.executable, args, options)).stdout; }
      catch (error) {
        const result = error as { code?: unknown; stdout?: unknown; killed?: boolean; signal?: string };
        if (result.code !== 1 || result.killed || result.signal || typeof result.stdout !== "string") throw error;
        raw = result.stdout; exit = 1;
      }
      return { ...parseOsvScanOutput(raw, exit, directory, request.ecosystem), scannerVersion, scannedAt, durationMs: Math.round(performance.now() - started) };
    } catch {
      return { verdict: "errored", findings: [], scannerVersion, scannedAt, durationMs: Math.round(performance.now() - started) };
    } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  }
}
