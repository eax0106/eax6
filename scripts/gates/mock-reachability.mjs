import { finding, isTestFile, sourceFiles } from './lib.mjs';
import { doesRealWork, lineOf, parse, ts, walk } from './ast.mjs';

/**
 * Gate: no fabricated implementation on a production path.
 *
 * Closes systemic pattern 1. Four of the previous build's six critical
 * findings were mock implementations behind real interfaces, and not one was
 * marked. The whole non-test codebase held one TODO and one FIXME — an absence
 * read as discipline when it was only absence.
 *
 * Rebuilt after the Adversary evaded the first version, which matched on
 * names — Mock, Fake, Stub prefixes. Both of these passed it:
 *
 *   export const createNotificationProvider = () => ({
 *     send: async () => ({ id: 'sent_123', accepted: true }),
 *   });
 *
 *   export class SesNotificationProvider implements NotificationProvider {
 *     async send(): Promise<SendResult> {
 *       return { id: 'sent_123', accepted: true };
 *     }
 *   }
 *
 * Neither is named like a mock. Both return canned data. The name was never
 * the signal — the fabricated body is.
 *
 * It also fixed a second bug: one assertMockAllowed() anywhere in a file was
 * treated as guarding every mock in it. The guard must now be in the same
 * function or its enclosing class.
 */

export const name = 'mock-reachability';
export const closes = 'Pattern 1 — mock code did not announce itself';

const MARKER = /@mock\b/;
const CONSTANT_MARKER = /@constant\b/;

/** Is the body nothing but `return <literal-only object or array>`? */
function returnsCannedData(fn) {
  if (!fn?.body) return false;

  let canned = false;

  const inspect = (expression) => {
    if (!expression) return;
    if (ts.isObjectLiteralExpression(expression) || ts.isArrayLiteralExpression(expression)) {
      canned = true;
    }
    // An arrow with an expression body: () => ({ ... })
    if (ts.isParenthesizedExpression(expression)) inspect(expression.expression);
  };

  if (!ts.isBlock(fn.body)) {
    inspect(fn.body);
  } else {
    for (const statement of fn.body.statements) {
      if (ts.isReturnStatement(statement)) inspect(statement.expression);
    }
  }

  return canned;
}

/** Does this function, or its enclosing class, gate itself? */
function isGated(fn, source) {
  const scopes = [fn];
  let current = fn.parent;
  while (current) {
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
      scopes.push(current);
      break;
    }
    current = current.parent;
  }

  for (const scope of scopes) {
    let gated = false;
    walk(scope, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'assertMockAllowed'
      ) {
        gated = true;
      }
    });
    if (gated) return true;
  }

  void source;
  return false;
}

function describe(fn, source) {
  if (ts.isMethodDeclaration(fn) && fn.name) {
    const owner = fn.parent?.name?.text ?? 'an anonymous class';
    return `${owner}.${fn.name.getText(source)}`;
  }
  if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text;
  const declaration = fn.parent;
  if (ts.isVariableDeclaration(declaration) && declaration.name) {
    return declaration.name.getText(source);
  }
  if (ts.isPropertyAssignment(declaration) && declaration.name) {
    return declaration.name.getText(source);
  }
  return 'an anonymous function';
}

export async function run() {
  const findings = [];
  const files = await sourceFiles({ includeTests: false });

  for (const file of files) {
    if (isTestFile(file)) continue;

    const { text, source } = await parse(file);

    walk(source, (node) => {
      const isFunctionLike =
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node);

      if (!isFunctionLike) return;
      if (!returnsCannedData(node)) return;
      if (doesRealWork(node)) return;

      const line = lineOf(source, node);
      const what = describe(node, source);

      // A deliberately constant value — a default config, a lookup table — is
      // legitimate, but it has to say so.
      const leading = text.slice(Math.max(0, node.getFullStart()), node.getStart(source));
      if (CONSTANT_MARKER.test(leading)) return;

      const announced = MARKER.test(leading);

      if (!announced) {
        findings.push(
          finding({
            file,
            line,
            message:
              `${what} returns canned data without doing any work — no call, ` +
              'no await, no state read. It is a mock whatever it is named. ' +
              'Mark it @mock and gate it, or @constant if the value is genuinely fixed.',
          }),
        );
        return;
      }

      if (!isGated(node, source)) {
        findings.push(
          finding({
            file,
            line,
            message:
              `${what} is marked @mock but neither it nor its class calls ` +
              'assertMockAllowed(). It would be selectable in production.',
          }),
        );
      }
    });
  }

  return findings;
}
