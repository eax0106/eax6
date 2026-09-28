import { finding, isTestFile, scriptFiles, sourceFiles } from './lib.mjs';
import { lineOf, parse, ts, walk } from './ast.mjs';

/**
 * Gate: a function that verifies something must be called by something other
 * than its own test.
 *
 * Pattern 3 has now appeared three times in this build, and the
 * driver-existence gate caught none of them, because that gate looks for
 * background work — timers, poll loops, subscriptions — and none of these are
 * background work. They are ordinary functions that check something and are
 * never called outside a test:
 *
 *   1. The previous build's audit-chain verifier. Detected all four tamper
 *      modes. One reference in the entire repository: its own definition.
 *   2. `assertInventoryCovers`, in my own component 35. Real, tested,
 *      decorative.
 *   3. `certifySchemaCoverage`, in component 44. Called only from
 *      registry.test.ts, which creates a probe designed to fail. A real
 *      migration adding an unregistered tenant table passes that test
 *      untouched.
 *
 * Three times is a gate gap, not three coincidences. The shared shape is a
 * function whose whole purpose is to detect a problem, tested against a
 * problem the test itself creates, and never pointed at production reality.
 *
 * A verifier tested only by its own test is a smoke alarm in a drawer. It
 * works perfectly and it is not installed anywhere.
 */

export const name = 'verifier-driver';
export const closes = 'Pattern 3 — a verifier nothing production calls';

/** Names that promise a check. The verb is the signal, not the subject. */
const VERIFY_PREFIX =
  /^(assert|verify|certify|validate|check|ensure|detect|audit|enforce|require)[A-Z_]/;

const ALLOW = /@verifier-driver\s+(\S+)/;

function exportedVerifiers(source, text) {
  const found = [];

  walk(source, (node) => {
    let name;
    let target = node;

    if (ts.isFunctionDeclaration(node) && node.name) {
      name = node.name.text;
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const isFunction =
        node.initializer &&
        (ts.isArrowFunction(node.initializer) ||
          ts.isFunctionExpression(node.initializer));
      if (!isFunction) return;
      name = node.name.text;
    } else {
      return;
    }

    if (!VERIFY_PREFIX.test(name)) return;

    // An explicit escape hatch, so a genuinely library-only checker can say so
    // and name who is expected to call it.
    const leading = text.slice(Math.max(0, target.getFullStart()), target.getStart(source));
    if (ALLOW.test(leading)) return;

    found.push({ name, node: target });
  });

  return found;
}

function callsTo(source, name) {
  let calls = 0;

  walk(source, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = ts.isIdentifier(node.expression)
      ? node.expression.text
      : ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : undefined;
    if (callee === name) calls += 1;
  });

  return calls;
}

export async function run() {
  const findings = [];
  const all = await sourceFiles();

  // Build scripts are .mjs and are real production drivers — generate-inventory
  // runs in CI on every push. A gate that only reads .ts cannot see them, which
  // would report a genuinely-driven verifier as undriven.
  const scripts = await scriptFiles();

  const parsed = [];
  for (const file of [...all, ...scripts]) {
    parsed.push({ file, ...(await parse(file)) });
  }

  const production = parsed.filter((entry) => !isTestFile(entry.file));

  for (const { file, text, source } of production) {
    for (const { name: verifier, node } of exportedVerifiers(source, text)) {
      // Same-file callers count. A helper called by an exported function three
      // lines away is driven; ignoring that reported Builder C's `checkEvent`
      // as undriven when `verifyEvents` calls it twice in the same file.
      const calledFromProduction = production.some(
        (candidate) => callsTo(candidate.source, verifier) > 0,
      );

      if (calledFromProduction) continue;

      findings.push(
        finding({
          file,
          line: lineOf(source, node),
          message:
            `"${verifier}" verifies something and is called by nothing outside ` +
            'a test. A verifier tested only by its own test is a smoke alarm in ' +
            'a drawer — it works, and it is not installed. Call it from a real ' +
            'path, or mark it @verifier-driver <name> saying who will.',
        }),
      );
    }
  }

  return findings;
}
