import { finding, isTestFile, sourceFiles } from './lib.mjs';
import { lineOf, parse, ts, walk } from './ast.mjs';

/**
 * Gate: one definition per shared primitive.
 *
 * Closes systemic pattern 4. The previous build had two ID validators with
 * different strictness — one enforcing strict UUIDv7, another accepting any
 * version 1 through 7 — and which one a boundary happened to import decided
 * what that boundary accepted. It also shipped two packages whose entire
 * contents were `export {}`, linted and built on every CI run.
 *
 * Rebuilt after the Adversary evaded the first version, which skipped every
 * `index.ts` on the assumption that barrels only re-export. A barrel can hold
 * a real declaration, and a duplicate hiding there is the worst case: it is
 * the file every consumer imports from.
 *
 * Barrels are no longer skipped. Only AST-confirmed pure re-export statements
 * are ignored.
 */

export const name = 'duplicate-primitive';
export const closes = 'Pattern 4 — duplicated primitives drifted apart';

const ALLOW_DUPLICATES = new Set(['main', 'run', 'name', 'closes', 'default']);

/** Declared names that are exported, excluding pure re-exports. */
function declarationsIn(source) {
  const declared = [];

  walk(source, (node) => {
    // `export { x } from './y'` and `export * from './y'` re-export without
    // declaring. Everything else that carries a name is a declaration.
    if (ts.isExportDeclaration(node)) return;

    const isExported = node.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!isExported) return;

    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      if (node.name) declared.push({ symbol: node.name.text, node });
      return;
    }

    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          declared.push({ symbol: declaration.name.text, node: declaration });
        }
      }
    }
  });

  return declared;
}

/** A barrel that re-exports nothing and declares nothing. */
function isEmptyBarrel(source) {
  const meaningful = source.statements.filter(
    (statement) =>
      !(
        ts.isExportDeclaration(statement) &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.length === 0 &&
        !statement.moduleSpecifier
      ),
  );
  return meaningful.length === 0;
}

export async function run() {
  const findings = [];
  const files = await sourceFiles({ includeTests: false });
  const seen = new Map();

  for (const file of files) {
    if (isTestFile(file)) continue;

    const { source } = await parse(file);

    // Barrels are parsed like any other file now. A pure re-export declares
    // nothing and produces no entries; a real declaration inside one does.
    for (const { symbol, node } of declarationsIn(source)) {
      if (ALLOW_DUPLICATES.has(symbol)) continue;

      const line = lineOf(source, node);
      const existing = seen.get(symbol);

      if (existing) {
        findings.push(
          finding({
            file,
            line,
            message:
              `"${symbol}" is also defined at ${existing.file}:${existing.line}. ` +
              'Two definitions drift, and which one a boundary imports decides ' +
              'what it accepts. Pick one home and import it.',
          }),
        );
        continue;
      }

      seen.set(symbol, { file, line });
    }

    if (isEmptyBarrel(source)) {
      findings.push(
        finding({
          file,
          line: 1,
          message: 'Empty module. It builds and lints and contains nothing.',
        }),
      );
    }
  }

  return findings;
}
