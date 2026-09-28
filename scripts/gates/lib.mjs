import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  'coverage',
  'docs',
  '.github',
  // This repository (task C1): tool caches, virtualenvs and generated code.
  '.nx',
  '.venv',
  'generated',
]);

/** Every TypeScript source file in the repository, repo-relative. */
export async function sourceFiles({ includeTests = true } = {}) {
  const found = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
      if (!includeTests && isTestFile(entry.name)) continue;
      found.push(relative(REPO_ROOT, full));
    }
  }

  await walk(REPO_ROOT);
  return found.sort();
}

/** Build and gate scripts. Real production drivers, written as .mjs. */
export async function scriptFiles() {
  const found = [];

  async function walkScripts(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkScripts(full);
      } else if (entry.name.endsWith('.mjs')) {
        found.push(relative(REPO_ROOT, full));
      }
    }
  }

  await walkScripts(join(REPO_ROOT, 'scripts'));
  return found.sort();
}

export function isTestFile(path) {
  return (
    path.includes('.test.') ||
    path.includes('.spec.') ||
    path.includes('/__tests__/')
  );
}

export async function readLines(path) {
  const text = await readFile(join(REPO_ROOT, path), 'utf8');
  return text.split('\n');
}

/**
 * A gate reports findings. It does not decide whether they are fatal — the
 * runner does that, from GATE_MODE. Every gate is defined before it is
 * enforced, so the true violation count is known before anything blocks.
 */
export function finding({ file, line, message }) {
  return { file, line, message };
}
