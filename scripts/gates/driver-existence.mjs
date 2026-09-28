import { finding, isTestFile, sourceFiles } from './lib.mjs';
import { lineOf, parse, ts, walk } from './ast.mjs';

/**
 * Gate: every background capability has a driver that something actually
 * starts.
 *
 * Closes systemic pattern 3, the most expensive one. The previous build had a
 * durable queue with correct leasing that no scheduler ever drove — a search
 * for every scheduler primitive across the service returned zero matches. It
 * had an audit-chain verifier detecting all four tamper modes with exactly one
 * reference in the repository: its own definition. It had a promotion gate the
 * audit called the best-designed component in the codebase, with zero
 * production callers.
 *
 * Real machinery. Nothing driving it. All of it passing tests.
 *
 * Rebuilt after the Adversary evaded the first version twice:
 *
 *   1. The subject list was name-based — Queue, Scheduler, Worker, Poller,
 *      Reaper, Sweeper, Relay, Monitor. A class called `ExpiryJanitor` needed
 *      no driver at all.
 *   2. Even a detected class passed with fake proof, because the check only
 *      searched test text for the driver's name:
 *          it('mentions startExpiryJanitor', () => expect(true).toBe(true));
 *
 * Both are fixed. Subjects are found structurally, and the driver must be
 * called — not mentioned — from a non-test module.
 */

export const name = 'driver-existence';
export const closes = 'Pattern 3 — real machinery with nothing driving it';

const DRIVER_TAG = /@driver\s+(\S+)/;

/** Timer and polling primitives: background work regardless of its name. */
const BACKGROUND_CALLS = new Set([
  'setInterval',
  'setTimeout',
  'setImmediate',
  'scheduleJob',
  'createWorker',
  'poll',
  'subscribe',
  'consume',
]);

function backgroundEvidence(node, source) {
  const reasons = [];

  walk(node, (inner) => {
    if (ts.isCallExpression(inner)) {
      const callee = ts.isIdentifier(inner.expression)
        ? inner.expression.text
        : ts.isPropertyAccessExpression(inner.expression)
          ? inner.expression.name.text
          : undefined;

      if (callee && BACKGROUND_CALLS.has(callee)) {
        reasons.push(`calls ${callee}() at line ${lineOf(source, inner)}`);
      }
    }

    // while (true) { await ... } — a poll loop under any name.
    if (
      ts.isWhileStatement(inner) &&
      inner.expression.kind === ts.SyntaxKind.TrueKeyword
    ) {
      let awaits = false;
      walk(inner.statement, (body) => {
        if (ts.isAwaitExpression(body)) awaits = true;
      });
      if (awaits) {
        reasons.push(`runs an awaiting while(true) loop at line ${lineOf(source, inner)}`);
      }
    }
  });

  return reasons;
}

/** Is `driver` actually called somewhere outside a test? */
function callsDriver(source, driver) {
  let called = false;

  walk(source, (node) => {
    if (called) return;
    if (!ts.isCallExpression(node)) return;

    const callee = ts.isIdentifier(node.expression)
      ? node.expression.text
      : ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : undefined;

    if (callee === driver) called = true;
  });

  return called;
}

export async function run() {
  const findings = [];
  const files = await sourceFiles({ includeTests: false });

  // Every non-test module is a candidate boot site. A driver mentioned only in
  // a test is not started in production, which was the whole failure.
  const parsed = [];
  for (const file of files) {
    if (isTestFile(file)) continue;
    parsed.push({ file, ...(await parse(file)) });
  }

  for (const { file, text, source } of parsed) {
    walk(source, (node) => {
      const isSubject =
        ts.isClassDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1);

      if (!isSubject) return;

      const reasons = backgroundEvidence(node, source);
      if (reasons.length === 0) return;

      const line = lineOf(source, node);
      const leading = text.slice(Math.max(0, node.getFullStart()), node.getStart(source));
      const declared = DRIVER_TAG.exec(leading);

      if (!declared) {
        findings.push(
          finding({
            file,
            line,
            message:
              `Background capability — ${reasons[0]} — with no @driver declaration. ` +
              'Name what starts this, or it is machinery with no driver.',
          }),
        );
        return;
      }

      const driver = declared[1];

      // Same-file callers count. A process entry point invokes its own main()
      // at module top level, which is a real driver — the process starts it.
      // Requiring the caller to live elsewhere reported Builder C's worker
      // boot as undriven when the line below it does exactly that.
      const startedBy = parsed.find((candidate) =>
        callsDriver(candidate.source, driver),
      );

      if (!startedBy) {
        findings.push(
          finding({
            file,
            line,
            message:
              `Declares @driver ${driver}, but no non-test module calls it. ` +
              'A driver that is only mentioned is not started — the previous ' +
              'build shipped a verifier whose sole reference was its own definition.',
          }),
        );
      }
    });
  }

  return findings;
}
