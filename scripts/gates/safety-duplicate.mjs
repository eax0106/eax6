import ts from 'typescript';
import { finding, sourceFiles, readLines } from './lib.mjs';

/**
 * Gate: Safety checks have one canonical implementation.
 *
 * Contract 37 forbids every caller from rebuilding SSRF, redaction, or
 * injection screening. This uses TypeScript's AST so aliases and formatting
 * cannot hide a direct DNS/socket/fetch import.
 */
export const name = 'safety-duplicate';
export const closes = 'Contract 37 — Safety checks have one canonical package';

const CANONICAL_PREFIX = 'packages/safety/';
const NETWORK_IMPORTS = new Map([
  ['node:dns', new Set(['lookup', 'resolve', 'resolve4', 'resolve6'])],
  ['node:dns/promises', new Set(['lookup', 'resolve', 'resolve4', 'resolve6'])],
  ['node:http', new Set(['get', 'request'])],
  ['node:https', new Set(['get', 'request'])],
  ['node:net', new Set(['connect', 'createConnection'])],
  ['node:tls', new Set(['connect'])],
]);
const SAFETY_DECLARATIONS = new Set([
  'classifyInjection',
  'createSsrfGuard',
  'fetchSafe',
  'redact',
  'screenInjection',
  'validateSsrfTarget',
]);

export async function run() {
  const findings = [];

  for (const file of await sourceFiles({ includeTests: false })) {
    if (file.startsWith(CANONICAL_PREFIX)) continue;
    let text;
    try {
      text = (await readLines(file)).join('\n');
    } catch {
      // A structural-test probe may have been removed after enumeration.
      continue;
    }
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2023, true);

    walk(source, (node) => {
      if (ts.isImportDeclaration(node)) {
        inspectImport(node, file, findings);
      }
      if (ts.isCallExpression(node)) {
        inspectNetworkCall(node, file, findings);
      }
      if (isNamedDeclaration(node) && SAFETY_DECLARATIONS.has(node.name.text)) {
        findings.push(
          finding({
            file,
            line: source.getLineAndCharacterOfPosition(node.name.getStart(source)).line + 1,
            message: `Safety primitive "${node.name.text}" must live in packages/safety`,
          }),
        );
      }
    });
  }

  return findings;
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function inspectImport(node, file, findings) {
  if (!ts.isStringLiteral(node.moduleSpecifier)) return;
  const protectedNames = NETWORK_IMPORTS.get(node.moduleSpecifier.text);
  if (protectedNames === undefined || node.importClause === undefined) return;

  const bindings = node.importClause.namedBindings;
  if (bindings === undefined || !ts.isNamedImports(bindings)) return;
  for (const imported of bindings.elements) {
    const importedName = imported.propertyName?.text ?? imported.name.text;
    if (!protectedNames.has(importedName)) continue;
    findings.push(
      finding({
        file,
        line: lineOf(node, node.getSourceFile()),
        message: `${networkLabel(importedName)} belongs only in packages/safety`,
      }),
    );
  }
}

function inspectNetworkCall(node, file, findings) {
  if (ts.isIdentifier(node.expression) && node.expression.text === 'fetch') {
    findings.push(
      finding({
        file,
        line: lineOf(node, node.getSourceFile()),
        message: 'Direct fetch bypasses packages/safety',
      }),
    );
  }
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'globalThis' &&
    node.expression.name.text === 'fetch'
  ) {
    findings.push(
      finding({
        file,
        line: lineOf(node, node.getSourceFile()),
        message: 'Direct globalThis.fetch bypasses packages/safety',
      }),
    );
  }
}

function isNamedDeclaration(node) {
  return (
    (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) || ts.isVariableDeclaration(node)) &&
    node.name !== undefined &&
    ts.isIdentifier(node.name)
  );
}

function lineOf(node, source) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function networkLabel(name) {
  if (name === 'lookup' || name.startsWith('resolve')) return 'DNS resolution';
  if (name === 'connect' || name === 'createConnection') return 'Socket creation';
  return 'HTTP request';
}
