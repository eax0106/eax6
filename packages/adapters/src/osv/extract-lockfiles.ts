import { gunzipSync } from "node:zlib";
import { posix } from "node:path";
import { MAX_PACKAGE_BYTES } from "./package-artifact";

const MAX_EXPANDED_BYTES = 50 * 1024 * 1024;
const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "requirements.txt", "Pipfile.lock", "poetry.lock", "pdm.lock", "pylock.toml", "uv.lock"]);
export type ExtractedLockfile = { path: string; bytes: Buffer };

/** Bounded POSIX ustar only; unsupported archives stay unscanned, never clean. */
export function extractPackageLockfiles(bytes: Buffer, name: string): ExtractedLockfile[] {
  if (!bytes.length || bytes.length > MAX_PACKAGE_BYTES) throw new Error("Empty or oversized package");
  const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED_BYTES }) : bytes;
  if (LOCKFILES.has(name)) return [{ path: name, bytes: raw }];
  if (raw.length < 1024 || raw.toString("ascii", 257, 262) !== "ustar") throw new Error("Package needs a supported lockfile or POSIX tar archive");
  const files: ExtractedLockfile[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let ended = false;
  const string = (header: Buffer, start: number, size: number) => header.subarray(start, start + size).toString("utf8").split("\0")[0]!;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (raw.subarray(offset).some(byte => byte !== 0)) throw new Error("Archive has data after its terminator");
      ended = true; break;
    }
    if (seen.size >= 1000) throw new Error("Archive exceeds entry limit");
    const checksum = string(header, 148, 8).trim();
    const expected = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    const sizeText = string(header, 124, 12).trim();
    if (!/^[0-7]+$/.test(checksum) || parseInt(checksum, 8) !== expected || !/^[0-7]+$/.test(sizeText)) throw new Error("Invalid tar header");
    const size = parseInt(sizeText, 8);
    const prefix = string(header, 345, 155);
    const path = `${prefix ? prefix + "/" : ""}${string(header, 0, 100)}`.replace(/\/$/, "");
    if (!path || posix.isAbsolute(path) || /[\\\x00-\x1f]/.test(path) || /^[A-Za-z]:/.test(path) || path.split("/").some(part => !part || part === "." || part === "..") || seen.has(path)) throw new Error("Invalid or duplicate archive path");
    seen.add(path);
    const type = header[156];
    if (type !== 0 && type !== 48 && type !== 53) throw new Error("Archive links and extended entries are not supported");
    if (type === 53 && size !== 0) throw new Error("Directory entry has content");
    const end = offset + 512 + size;
    if (end > raw.length || size > MAX_EXPANDED_BYTES) throw new Error("Truncated or oversized archive entry");
    if (type !== 53 && LOCKFILES.has(posix.basename(path))) files.push({ path, bytes: raw.subarray(offset + 512, end) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!ended || !files.length) throw new Error("Archive is incomplete or contains no supported lockfile");
  return files;
}
