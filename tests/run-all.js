'use strict';
/*
 * tests/run-all.js — the `npm test` entry point.
 *
 * Runs every suite as an isolated child process and prints one aggregate
 * summary. Exits non-zero if any suite failed. Unlike tests/e2e/nightly.js
 * this writes NO report file — it is the fast, interactive dev loop.
 *
 * Todos are surfaced in the summary but never fail the run: declared-but-
 * unimplemented coverage is honest reporting, not a failure.
 *
 * Node built-ins only: path, child_process.
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TESTS_DIR = __dirname;
const ROOT = path.resolve(TESTS_DIR, '..');

const SUITES = [
  { id: 'verify-single-file', script: path.join(TESTS_DIR, 'verify-single-file.js') },
  { id: 'dsp-worker', script: path.join(TESTS_DIR, 'dsp-worker.test.js') },
  { id: 'audio-capture', script: path.join(TESTS_DIR, 'audio-capture.test.js') },
  { id: 'ai-dissector', script: path.join(TESTS_DIR, 'ai-dissector.test.js') },
  { id: 'ui-layout', script: path.join(TESTS_DIR, 'ui-layout.test.js') },
  { id: 'visualizer', script: path.join(TESTS_DIR, 'visualizer.test.js') },
  { id: 'theming', script: path.join(TESTS_DIR, 'theming.test.js') },
  { id: 'vibe-translators', script: path.join(TESTS_DIR, 'vibe-translators.test.js') },
  { id: 'structure-builder', script: path.join(TESTS_DIR, 'structure-builder.test.js') },
  { id: 'compiler', script: path.join(TESTS_DIR, 'compiler.test.js') },
  { id: 'midi-export', script: path.join(TESTS_DIR, 'midi-export.test.js') },
  { id: 'limiter-eval', script: path.join(TESTS_DIR, 'limiter-eval.js') },
];

function parseCounts(stdout) {
  const m = /---\s.*?:\s(\d+)\/(\d+)\spassed,\s(\d+)\sfailed,\s(\d+)\stodo/.exec(stdout || '');
  if (!m) return { passed: null, total: null, failed: null, todo: null, parsed: false };
  return {
    passed: Number(m[1]),
    total: Number(m[2]),
    failed: Number(m[3]),
    todo: Number(m[4]),
    parsed: true,
  };
}

console.log(`SunoPrompt Studio — test run (node ${process.version}, ${process.platform})`);

const results = [];
for (const suite of SUITES) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [suite.script], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  const stdout = res.stdout || '';
  if (stdout) process.stdout.write(stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.error) console.log(`  spawn error: ${res.error.message}`);
  results.push({
    id: suite.id,
    exitCode: res.status === null ? -1 : res.status,
    ok: res.status === 0,
    durationMs: Date.now() - started,
    counts: parseCounts(stdout),
  });
}

const totals = results.reduce(
  (acc, r) => {
    acc.passed += r.counts.passed || 0;
    acc.failed += r.counts.failed || 0;
    acc.todo += r.counts.todo || 0;
    return acc;
  },
  { passed: 0, failed: 0, todo: 0 }
);

const failed = results.filter((r) => !r.ok);

console.log('\n========================================');
console.log('  AGGREGATE SUMMARY');
console.log('========================================');
for (const r of results) {
  const counts = r.counts.parsed
    ? `${r.counts.passed}/${r.counts.total} passed, ${r.counts.failed} failed, ${r.counts.todo} todo`
    : 'no summary line parsed';
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(20)} exit ${r.exitCode}  ${counts}  (${r.durationMs}ms)`);
}
console.log('  ----------------------------------------');
console.log(`  ${results.length} suites: ${totals.passed} passed, ${totals.failed} failed, ${totals.todo} todo`);
console.log(`  RESULT: ${failed.length === 0 ? 'GREEN' : 'RED'}`);
if (failed.length) console.log(`  failed suites: ${failed.map((r) => r.id).join(', ')}`);
console.log('');

process.exitCode = failed.length === 0 ? 0 : 1;
