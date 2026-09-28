import { finding, isTestFile, sourceFiles } from './lib.mjs';
import { lineOf, parse, ts, walk } from './ast.mjs';

/**
 * Gate: no test reads the .env file.
 *
 * This bug has now shipped twice. `registry.test.ts` opened `.env`
 * unconditionally and failed CI, which has no such file; it was fixed. Then
 * `observability-driver.test.ts` did the same thing and failed CI the same
 * way, because nothing stopped it.
 *
 * The shape is nastier than it looks. A test reading `.env` passes on the
 * machine that wrote it and fails only in CI — so it is discovered late, by
 * someone else, and looks like an infrastructure problem rather than a test
 * problem. It also quietly verifies the code under conditions the real system
 * does not have, which is the failure this whole rebuild exists to prevent.
 *
 * `vitest.config.ts` already loads `.env` into the test environment when one
 * exists, and CI exports the same variables with no file present. So tests
 * read `process.env` and never the file, and configuration goes through
 * `loadConfig()`.
 *
 * The config module and vitest.config.ts are the only places allowed to touch
 * the file, and they are not tests.
 */

export const name = 'test-env-file';
export const closes = 'A test that reads .env passes locally and fails in CI';

const ENV_FILENAME = /(^|\/)\.env(\.|$)/;

export async function run() {
  const findings = [];
  const files = await sourceFiles();

  for (const file of files) {
    if (!isTestFile(file)) continue;

    const { source } = await parse(file);

    walk(source, (node) => {
      if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) {
        return;
      }
      if (!ENV_FILENAME.test(node.text)) return;

      findings.push(
        finding({
          file,
          line: lineOf(source, node),
          message:
            `Reads "${node.text}" from a test. That passes on the machine that ` +
            'wrote it and fails in CI, which has no such file. Use process.env ' +
            'through loadConfig() — vitest.config.ts already loads .env when one exists.',
        }),
      );
    });
  }

  return findings;
}
