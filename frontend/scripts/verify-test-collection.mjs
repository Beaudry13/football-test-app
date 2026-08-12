/**
 * Run the frontend suite and FAIL if a test file on disk did not actually run.
 *
 * WHY THIS EXISTS
 * ---------------
 * A full-suite run reported `75 files / 867 tests` on a tree that had reported
 * `76 files / 906 tests` minutes earlier, with no failure and nothing in the
 * summary to say a file was missing. `QuestionEditor.test.tsx` - 39 tests -
 * had simply not run. A green suite that can quietly shrink is not a gate.
 *
 * WHY THIS SCRIPT IS THE GATE RATHER THAN vitest's EXIT CODE
 * ----------------------------------------------------------
 * `vitest run` exits 1 on this project even when every test passes: jsdom
 * raises unhandled errors from canvas `drawImage` and `scrollIntoView`, and
 * Vitest counts those as errors. CLAUDE.md has documented that for a while.
 *
 * That is precisely why a missing file went unnoticed - the one channel that
 * should have shouted was already permanently red, so no signal could be read
 * from it at all.
 *
 * So this asserts the two things the exit code can no longer tell us:
 *   1. every test file on disk actually ran, and
 *   2. no test failed
 * reading both from the run's own JSON report. It tolerates the known
 * unhandled errors and fails on anything real.
 *
 * WHY IT SPAWNS VITEST ITSELF
 * ---------------------------
 * Chaining in package.json does not work here. `&&` never reaches the guard,
 * because vitest always exits non-zero. `;` is not a separator in the shell
 * npm uses on Windows - it was passed to vitest as a test-name filter, which
 * silently ran zero tests and still wrote a report. One Node entry point has
 * neither problem on any platform.
 *
 * WHY NOT A HARD-CODED FILE COUNT
 * -------------------------------
 * "Expect 76" breaks the moment someone adds a test, and would pass if one
 * file were added while another vanished. The check is set-against-set by
 * path, against whatever is on disk right now.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, globSync, readFileSync, rmSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const REPORT = resolve(root, '.vitest-report.json');

// A stale report from a previous run would let a crashed run "pass" by
// verifying yesterday's results.
if (existsSync(REPORT)) rmSync(REPORT);

// Vitest's own JS entry point, run with THIS node binary.
//
// Not `npx` and not `npx.cmd`: Node 24 refuses to spawnSync a .cmd without
// shell:true (EINVAL, from the CVE-2024-27980 fix), and turning the shell on
// to work around that reintroduces exactly the quoting and separator problems
// that made package.json chaining unusable in the first place.
const vitestEntry = resolve(root, 'node_modules/vitest/vitest.mjs');

const vitest = spawnSync(
  process.execPath,
  [
    vitestEntry,
    'run',
    // Documented in CLAUDE.md: default parallelism makes several files fail
    // from host-load timing. Sequential gives a clean run.
    '--no-file-parallelism',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${REPORT}`,
    ...process.argv.slice(2),
  ],
  { cwd: root, stdio: 'inherit', shell: false },
);

function fail(lines) {
  console.error('');
  for (const line of lines) console.error(`  ${line}`);
  console.error('');
  process.exit(1);
}

if (vitest.error) {
  fail(['COULD NOT RUN VITEST', String(vitest.error)]);
}

/** Every test file that exists. The source of truth. */
const onDisk = globSync('src/**/*.test.{ts,tsx}', { cwd: root })
  .map((p) => p.replaceAll('\\', '/'))
  .sort();

if (onDisk.length === 0) {
  fail(['found no test files at all - is the glob wrong?']);
}

let report;
try {
  report = JSON.parse(readFileSync(REPORT, 'utf8'));
} catch (error) {
  // No readable report means the run did not finish the way we think it did,
  // which is exactly the situation this guard exists for. Never pass.
  fail(['NO USABLE TEST REPORT', `expected ${REPORT}`, String(error)]);
}

const failedTests = report.numFailedTests ?? 0;
const failedSuites = report.numFailedTestSuites ?? 0;
if (failedTests > 0 || failedSuites > 0) {
  fail([
    'TESTS FAILED',
    `${failedTests} test(s) across ${failedSuites} file(s).`,
    'See the run output above.',
  ]);
}

const executed = new Set(
  (report.testResults ?? [])
    .map((result) => result.name ?? result.file ?? '')
    .filter(Boolean)
    .map((name) => relative(root, resolve(name)).replaceAll('\\', '/')),
);

const missing = onDisk.filter((file) => !executed.has(file));
if (missing.length > 0) {
  fail([
    'TEST COLLECTION GUARD FAILED',
    '----------------------------',
    `${onDisk.length} test files on disk, ${executed.size} actually ran.`,
    'These exist but did NOT run, and the suite still reported success:',
    ...missing.map((file) => `  - ${file}`),
    '',
    'A suite that can silently shrink is not a gate. If a file disappears',
    'repeatedly, find out what is killing its worker before trusting any',
    'green result.',
  ]);
}

// The run passed 0 tests only if something is badly wrong with the invocation.
if ((report.numPassedTests ?? 0) === 0) {
  fail(['THE RUN EXECUTED NO TESTS', 'Check the vitest invocation above.']);
}

console.log(
  `\ncollection guard: all ${onDisk.length} test files ran, ` +
    `${report.numPassedTests} tests passed, 0 failed.`,
);
