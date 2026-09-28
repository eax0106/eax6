import { finding, isTestFile, sourceFiles } from './lib.mjs';
import {
  environmentAccesses,
  lineOf,
  parse,
  permissiveFallbackOf,
  ts,
} from './ast.mjs';

/**
 * Gate: safety is what you get by doing nothing.
 *
 * Closes systemic pattern 2. In the previous build a missing environment
 * variable selected a mock; a half-configured deployment crashed loudly at
 * boot while a fully unconfigured one started happily and discarded every
 * email.
 *
 * Rebuilt after the Adversary evaded the first version. That version matched
 * `process.env[...]` on a single physical line, so all of these passed:
 *
 *   process.env.ALTER_RUNTIME_MODE ?? 'development'     // dot form
 *   process.env['X'] ??\n  'development'                // multi-line
 *   const { ALTER_AUTH_MODE: m = 'allow' } = process.env // destructured
 *   { ALTER_RUNTIME_MODE: 'development', ...process.env } // merge
 *   process.env['X'] ? process.env['X'] : 'mock'         // ternary
 *
 * Two checks now. The second is the structural one and matters more.
 */

export const name = 'unsafe-default';
export const closes = 'Pattern 2 — missing configuration silently selected a mock';

/**
 * The one module allowed to read process.env. Everything else takes config as
 * a parameter. Confining environment access to a single audited file is a
 * stronger guarantee than trying to recognise every unsafe shape.
 */
const CONFIG_MODULES = [
  'packages/contracts/src/runtime-mode.ts',
  'packages/contracts/src/config.ts',
  'scripts/',
];

function isConfigModule(file) {
  return CONFIG_MODULES.some((allowed) => file.startsWith(allowed));
}

export async function run() {
  const findings = [];
  const files = await sourceFiles({ includeTests: false });

  for (const file of files) {
    if (isTestFile(file)) continue;

    const { source } = await parse(file);
    const accesses = environmentAccesses(source);
    if (accesses.length === 0) continue;

    for (const access of accesses) {
      const line = lineOf(source, access);

      // Check 1: a permissive default reachable from an env read, in any shape.
      const fallback = permissiveFallbackOf(access);
      if (fallback) {
        findings.push(
          finding({
            file,
            line,
            message:
              `Environment read falls back to "${fallback.getText(source)}". ` +
              'Unset must never grant a permission — fail, or default to the safe side.',
          }),
        );
        continue;
      }

      // An object spread of process.env lets any later literal win silently.
      if (ts.isSpreadAssignment(access)) {
        findings.push(
          finding({
            file,
            line,
            message:
              'process.env is spread into an object literal. Whichever key is ' +
              'written last wins, so a permissive default can be introduced ' +
              'without appearing to override anything.',
          }),
        );
        continue;
      }

      // Check 2: the structural one. Environment access outside the config
      // module is the thing that makes unsafe defaults possible at all.
      if (!isConfigModule(file)) {
        findings.push(
          finding({
            file,
            line,
            message:
              'Reads process.env outside the config module. Take configuration ' +
              'as a parameter — confining environment access to one audited ' +
              'place is what makes an unsafe default impossible rather than ' +
              'merely detectable.',
          }),
        );
      }
    }
  }

  return findings;
}
