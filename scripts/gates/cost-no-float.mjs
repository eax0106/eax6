import ts from 'typescript';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { REPO_ROOT, isTestFile } from './lib.mjs';

/** Contract 39: money stays integer minor units; floating point is forbidden. */
export const name = 'cost-no-float';
export const closes = 'Contract 39 — no floating point in Cost Ledger';

// This repository's Cost Ledger is a service, its SQL in drizzle/ (task C1).
const LEDGER_ROOT = join(REPO_ROOT, 'apps/cost-ledger-service');

export async function run() {
  const findings = [];
  const sourceRoot = join(LEDGER_ROOT, 'src');
  const migrationRoot = join(LEDGER_ROOT, 'drizzle');
  // A moved ledger must fail this gate, not empty it.
  for (const root of [sourceRoot, migrationRoot]) {
    if ((await filesUnder(root, () => true)).length === 0) {
      throw new Error(`cost-no-float: ${relative(REPO_ROOT, root)} has no files -- the ledger moved`);
    }
  }

  for (const file of await filesUnder(sourceRoot, (file) => file.endsWith('.ts') && !isTestFile(file))) {
    const text = await readFile(file, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2023, true);
    inspectTypeScript(source, relative(REPO_ROOT, file), findings);
  }
  for (const file of await filesUnder(migrationRoot, (file) => file.endsWith('.sql'))) {
    const text = await readFile(file, 'utf8');
    inspectSql(text, relative(REPO_ROOT, file), findings);
  }

  return findings;
}

function inspectTypeScript(source, file, findings) {
  const visit = (node) => {
    if (ts.isNumericLiteral(node) && /[.eE]/.test(node.text)) {
      findings.push(floatFinding(file, source, node, `Floating-point literal ${node.text} is forbidden`));
    }
    if (node.kind === ts.SyntaxKind.NumberKeyword) {
      findings.push(floatFinding(file, source, node, 'Floating-point number type is forbidden'));
    }
    if (ts.isIdentifier(node) && node.text === 'Number') {
      findings.push(floatFinding(file, source, node, 'Number conversion is forbidden in Cost Ledger'));
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Math') {
      findings.push(floatFinding(file, source, node, 'Math APIs are forbidden in Cost Ledger'));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function inspectSql(text, file, findings) {
  const forbidden = /\b(?:double\s+precision|float(?:\d+)?|real|numeric|decimal)\b/gi;
  for (const match of text.matchAll(forbidden)) {
    const before = text.slice(0, match.index);
    findings.push({
      file,
      line: before.split('\n').length,
      message: `Floating-point SQL type ${match[0]} is forbidden`,
    });
  }
}

function floatFinding(file, source, node, message) {
  return {
    file,
    line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    message,
  };
}

async function filesUnder(root, include) {
  const found = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...await filesUnder(path, include));
    } else if (include(path)) {
      found.push(path);
    }
  }
  return found;
}
