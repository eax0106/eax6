import { access, chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { OsvPackageScanProvider, parseOsvScanOutput } from "./osv-package-scan-provider";
import { extractPackageLockfiles } from "./extract-lockfiles";
import { MAX_PACKAGE_BYTES } from "./package-artifact";

const request = { tenantId: "ten_00000000-0000-7000-8000-000000000001", manifestId: "tlm_00000000-0000-7000-8000-000000000002", manifestVersion: "1.0.0", artifactRef: "s3://fixtures/package-lock.json?versionId=1", ecosystem: "npm" as const };
const root = "/scanner";
const output = (findings = true, score = "8.1") => JSON.stringify({ results: [{ source: { path: "/scanner/package-lock.json" }, packages: [{ package: { name: "lodash", version: "4.17.20", ecosystem: "npm" },
  vulnerabilities: findings ? [{ id: "GHSA-35jh-r3h4-6jhm", summary: "Known affected dependency" }] : [], groups: [{ ids: ["GHSA-35jh-r3h4-6jhm"], max_severity: score }] }] }] });

export function tar(entries: { path: string; data?: Buffer; type?: string }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    header.write(entry.path); header.write("0000600\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124); header.write("00000000000\0", 136);
    header.fill(32, 148, 156); header.write(entry.type ?? "0", 156); header.write("ustar\0", 257); header.write("00", 263);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

describe("OSV package result", () => {
  it("preserves advisory/package identity and actual numeric severity", () => {
    expect(parseOsvScanOutput(output(), 1, root, "npm")).toEqual({ verdict: "findings", findings: [{ rule: "GHSA-35jh-r3h4-6jhm", severity: "high", locator: "package-lock.json:lodash@4.17.20", detail: "Known affected dependency (CVSS 8.1)" }] });
    expect(parseOsvScanOutput(output(false), 0, root, "npm")).toEqual({ verdict: "clean", findings: [] });
  });
  it.each([["9.8", "critical"], ["7", "high"], ["6.9", "medium"], ["3.9", "low"], ["0", "info"]])("classifies CVSS %s as %s", (score, expected) => {
    expect(parseOsvScanOutput(output(true, score), 1, root, "npm").findings[0]!.severity).toBe(expected);
  });
  it("does not silently treat incomplete or contradictory results as clean", () => {
    for (const [raw, exit] of [["{}", 0], ["not json", 0], ['{"results":[]}', 0], [output(), 0], [output(false), 1], [output(false), 128], [output(true, "99"), 1]] as const) {
      expect(() => parseOsvScanOutput(raw, exit, root, "npm")).toThrow();
    }
    expect(() => parseOsvScanOutput(output(), 1, root, "pip")).toThrow("ecosystem");
    expect(() => parseOsvScanOutput(output().replace("/scanner/package-lock.json", "/elsewhere/package-lock.json"), 1, root, "npm")).toThrow("source path");
  });
});

describe("package lockfile extraction", () => {
  const lock = Buffer.from('{"lockfileVersion":3}');
  it("extracts nested pinned inputs while ignoring package code and its scanner config", () => {
    const bytes = gzipSync(tar([{ path: "package", type: "5" }, { path: "package/package-lock.json", data: lock }, { path: "package/install.sh", data: Buffer.from("exit 99") }, { path: "package/osv-scanner.toml", data: Buffer.from('ignore=true') }]));
    expect(extractPackageLockfiles(bytes, "package.tgz")).toEqual([{ path: "package/package-lock.json", bytes: lock }]);
    expect(extractPackageLockfiles(lock, "package-lock.json")).toEqual([{ path: "package-lock.json", bytes: lock }]);
  });
  it("refuses traversal, links, duplicate paths, corruption, oversized and unsupported inputs", () => {
    for (const path of ["../package-lock.json", "/package-lock.json", "a/../package-lock.json", "C:/package-lock.json", "a\\package-lock.json"]) expect(() => extractPackageLockfiles(tar([{ path, data: lock }]), "a.tar")).toThrow();
    for (const type of ["1", "2", "x", "L"]) expect(() => extractPackageLockfiles(tar([{ path: "package-lock.json", type, data: lock }]), "a.tar")).toThrow();
    expect(() => extractPackageLockfiles(tar([{ path: "package-lock.json", data: lock }, { path: "package-lock.json", data: lock }]), "a.tar")).toThrow();
    const corrupt = tar([{ path: "package-lock.json", data: lock }]); corrupt[0] = 1;
    expect(() => extractPackageLockfiles(corrupt, "a.tar")).toThrow();
    expect(() => extractPackageLockfiles(tar([{ path: "package-lock.json", data: lock }]).subarray(0, 530), "a.tar")).toThrow();
    expect(() => extractPackageLockfiles(Buffer.alloc(MAX_PACKAGE_BYTES + 1), "requirements.txt")).toThrow();
    expect(() => extractPackageLockfiles(gzipSync(Buffer.alloc(51 * 1024 * 1024)), "bomb.tar.gz")).toThrow();
    expect(() => extractPackageLockfiles(tar([{ path: "package.json", data: lock }]), "a.tar")).toThrow();
  });
});

describe("scanner process and cleanup", () => {
  it("passes only lockfiles and an empty config to a credential-free process and cleans successful scans", async () => {
    const directory=await mkdtemp(join(tmpdir(),"alter-osv-isolation-test-")),executable=join(directory,"scanner"),marker=join(directory,"cwd"),scriptMarker=join(directory,"package-script-ran");
    vi.stubEnv("ALTER_SCANNER_FIXTURE_SECRET","fixture-must-not-be-inherited");
    await writeFile(executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'osv-scanner version: 2.6.0'; exit 0; fi\n[ -z "$ALTER_SCANNER_FIXTURE_SECRET" ] || exit 127\n[ ! -e package/install.sh ] || exit 127\n[ ! -e package/osv-scanner.toml ] || exit 127\n[ ! -s scanner-config.toml ] || exit 127\npwd > '${marker}'\nprintf '{"results":[{"source":{"path":"%s/package/package-lock.json"},"packages":[{"package":{"name":"left-pad","version":"1.3.0","ecosystem":"npm"},"vulnerabilities":[]}]}]}' "$HOME"\n`);
    await chmod(executable,0o700);
    try {
      const bytes=tar([{path:"package/package-lock.json",data:Buffer.from('{}')},{path:"package/install.sh",data:Buffer.from(`touch '${scriptMarker}'`)},{path:"package/osv-scanner.toml",data:Buffer.from('ignore=true')}]);
      const report=await new OsvPackageScanProvider({read:async()=>({name:"package.tar",bytes})},executable).scanPackage(request);
      expect(report.verdict).toBe("clean"); const {readFile}=await import("node:fs/promises"); await expect(access((await readFile(marker,"utf8")).trim())).rejects.toThrow();await expect(access(scriptMarker)).rejects.toThrow();
    } finally {vi.unstubAllEnvs();await rm(directory,{recursive:true,force:true});}
  });
  it("records errors without accepting scanner failures and removes extracted files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alter-osv-executable-test-"));
    const executable = join(directory, "scanner");
    const marker = join(directory, "cwd");
    await writeFile(executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'osv-scanner version: 2.6.0'; exit 0; fi\npwd > '${marker}'\necho '{"results":[]}'\nexit 128\n`);
    await chmod(executable, 0o700);
    try {
      const provider = new OsvPackageScanProvider({ read: async () => ({ name: "requirements.txt", bytes: Buffer.from("left-pad==1.3.0") }) }, executable);
      const report = await provider.scanPackage(request);
      expect(report.verdict).toBe("errored");
      expect(report.scannerVersion).toMatch(/^osv-scanner 2.6.0 sha256:[a-f0-9]{64}$/);
      const { readFile } = await import("node:fs/promises");
      const cwd = (await readFile(marker, "utf8")).trim();
      await expect(access(cwd)).rejects.toThrow();
      expect(await readdir(directory)).toEqual(["cwd", "scanner"]);
      expect((await new OsvPackageScanProvider({ read: async () => { throw new Error("unavailable object"); } }, executable).scanPackage(request)).verdict).toBe("errored");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe.skipIf(!process.env["OSV_SCANNER_EXECUTABLE"])("real OSV executable", () => {
  it("scans actual clean/affected pinned dependencies and refuses an empty dependency set", async () => {
    const executable = process.env["OSV_SCANNER_EXECUTABLE"]!;
    const scan = (name: string, version: string) => new OsvPackageScanProvider({ read: async () => ({ name: "package-lock.json", bytes: Buffer.from(JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { dependencies: { [name]: version } }, [`node_modules/${name}`]: { version } } })) }) }, executable).scanPackage(request);
    const affected = await scan("lodash", "4.17.20");
    expect(affected.verdict).toBe("findings");
    expect(affected.findings).toEqual(expect.arrayContaining([expect.objectContaining({ rule: "GHSA-35jh-r3h4-6jhm", severity: "high", locator: expect.stringContaining("lodash@4.17.20") })]));
    expect((await scan("left-pad", "1.3.0")).verdict).toBe("clean");
    const empty = new OsvPackageScanProvider({ read: async () => ({ name: "package-lock.json", bytes: Buffer.from('{"lockfileVersion":3,"packages":{}}') }) }, executable);
    expect((await empty.scanPackage(request)).verdict).toBe("errored");
  }, 180_000);
});
