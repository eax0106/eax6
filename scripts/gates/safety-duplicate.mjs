import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { finding, REPO_ROOT, sourceFiles } from './lib.mjs';
import { lineOf, parse, walk } from './ast.mjs';

export const name = 'safety-duplicate';
export const closes = 'D15 — one safety implementation per language';

const CANONICAL = new Map([
  ['packages/adapters/src/http/ssrf-guard.ts', new Set(['isBlockedIpLiteral', 'isBlockedIpv4', 'isBlockedIpv6', 'assertUrlSchemeAllowed', 'assertHostnameNotLiteralBlockedIp', 'assertResolvedAddressesNotBlocked'])],
  ['packages/adapters/src/http/ssrf-guarded-fetcher.ts', new Set(['SsrfGuardedFetcher'])],
  ['packages/adapters/src/presidio/presidio-pii-redaction-provider.ts', new Set(['PresidioPIIRedactionProvider'])],
  ['packages/auth/session-gateway/src/prompt-injection-classifier.ts', new Set(['PromptInjectionClassifier', 'parseClassifierOutput'])],
]);
const PRIMITIVES = new Set([
  ...[...CANONICAL.values()].flatMap(names => [...names]),
  'classifyInjection', 'createSsrfGuard', 'fetchSafe', 'redact', 'screenInjection', 'validateSsrfTarget',
]);

function implementations(source) {
  const found = [];
  walk(source, node => {
    const body = ts.isClassDeclaration(node) && node.members.length > 0 ? node
      : ts.isFunctionDeclaration(node) ? node.body
      : ts.isVariableDeclaration(node) && node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
        ? node.initializer.body : undefined;
    if (body && node.name && ts.isIdentifier(node.name)) found.push({ node, body, symbol: node.name.text });
  });
  return found;
}

// Identifier renames and formatting cannot hide a copied implementation.
// Small expressions are excluded: matching a trivial wrapper proves no duplication.
function signature(body) {
  const parts = [];
  walk(body, node => {
    parts.push(String(node.kind));
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) parts.push(JSON.stringify(node.text));
  });
  return parts.length >= 60 ? parts.join(':') : undefined;
}

export async function run() {
  const signatures = new Set();
  for (const [file, symbols] of CANONICAL) {
    const { source } = await parse(file);
    for (const entry of implementations(source)) {
      if (!symbols.has(entry.symbol)) continue;
      const value = signature(entry.body);
      if (value) signatures.add(value);
    }
  }
  const findings = [];
  for (const file of await sourceFiles({ includeTests: false })) {
    const { source } = await parse(file);
    for (const entry of implementations(source)) {
      if (CANONICAL.get(file)?.has(entry.symbol)) continue;
      if (!PRIMITIVES.has(entry.symbol) && !signatures.has(signature(entry.body))) continue;
      findings.push(finding({ file, line: lineOf(source, entry.node),
        message: `Safety implementation "${entry.symbol}" must reuse its canonical implementation` }));
    }
  }
  return findings.concat(JSON.parse(execFileSync('python3', [
    join(REPO_ROOT, 'scripts/gates/safety-duplicate-python.py'), REPO_ROOT,
  ], { encoding: 'utf8' })));
}
